import {
  ModelComparisonDecisionSchema,
  ModelComparisonQueueReleaseRequestSchema,
  ModelComparisonSeriesEntrySchema,
  ModelComparisonSeriesSchema,
  ModelComparisonTaskSelectionSchema,
  type ModelComparisonDecision,
  type ModelComparisonEntryStatus,
  type ModelComparisonEvaluationLink,
  type ModelComparisonParent,
  type ModelComparisonResidualBlock,
  type ModelComparisonScheduleEntry,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
  type ModelComparisonTaskSelection,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, computeTasksetHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";

const TRANSITIONS: Record<ModelComparisonEntryStatus, ReadonlySet<ModelComparisonEntryStatus>> = {
  draft: new Set(["ready", "cancelled"]),
  ready: new Set(["queued", "cancelled"]),
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["candidate", "no_signal", "failed", "cancelled"]),
  candidate: new Set(["accepted", "rejected"]),
  accepted: new Set(),
  rejected: new Set(),
  no_signal: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function createModelComparisonSeriesService(store: SqliteStore) {
  async function saveSeries(input: unknown): Promise<ModelComparisonSeries> {
    const series = ModelComparisonSeriesSchema.parse(input);
    const project = await store.getModelProject(series.modelProjectId);
    if (!project || project.profileId !== series.profileId) {
      throw new Error("The Model Project does not belong to the Comparison Series Profile.");
    }
    const existing = await store.getModelComparisonSeries(series.id);
    if (existing?.scheduleSealedAt) {
      throw new Error("A sealed Comparison Series cannot be edited through the draft save path.");
    }
    if (!existing && (series.revision !== 1 || series.status !== "draft" || series.scheduleSealedAt)) {
      throw new Error("A new Comparison Series must begin as unsealed draft revision 1.");
    }
    await requireSeriesTasksets(series);
    return store.saveModelComparisonSeries(series);
  }

  async function sealSeries(input: { seriesId: string; expectedRevision: number }): Promise<ModelComparisonSeries> {
    const series = await requireSeries(input.seriesId);
    if (series.scheduleSealedAt) return series;
    requireRevision(series, input.expectedRevision);
    await requireSeriesTasksets(series);
    const timestamp = new Date().toISOString();
    return store.saveModelComparisonSeries({
      ...series,
      status: "active",
      revision: series.revision + 1,
      scheduleSealedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async function queueRelease(inputValue: unknown): Promise<{
    series: ModelComparisonSeries;
    entry: ModelComparisonSeriesEntry;
  }> {
    const input = ModelComparisonQueueReleaseRequestSchema.parse(inputValue);
    const series = await requireSeries(input.seriesId);
    const scheduled = requireScheduledEntry(series, input.scheduleEntryId);
    const existing = (await store.listModelComparisonSeriesEntries({ seriesId: series.id }))
      .find((entry) => entry.scheduleEntryId === scheduled.id);
    if (existing) return { series, entry: existing };
    requireRevision(series, input.expectedSeriesRevision);
    if (!series.scheduleSealedAt || series.status !== "active") {
      throw new Error("Seal the Comparison Series before queueing a release.");
    }

    const release = await resolveTaskRelease(series, scheduled, input.taskSelection);
    if (release.taskCount < scheduled.minimumTasks || release.taskCount > scheduled.maximumTasks) {
      throw new Error(`Release ${scheduled.label} requires ${scheduled.minimumTasks}-${scheduled.maximumTasks} tasks; received ${release.taskCount}.`);
    }
    const parentEntry = await resolveParentEntry(series, scheduled);
    const parent = await resolveParent(series, scheduled, parentEntry);
    const blocks = buildBlocks(series, scheduled, parentEntry);
    const trainableBlock = blocks.find((block) => block.optimizationRole === "trainable")!;
    const timestamp = release.reviewedAt ?? new Date().toISOString();
    const releaseHash = contentHash({
      seriesId: series.id,
      scheduleEntryId: scheduled.id,
      ordinal: scheduled.ordinal,
      role: scheduled.role,
      parent,
      taskset: exactRef(release.taskset),
      sourceTasksets: release.sourceTasksets,
      trainableRank: scheduled.trainableRank,
      serializedEnvelopeRank: series.residualProfile.serializedEnvelopeRank,
      enabledCumulativeRank: blocks.at(-1)!.offsetEnd,
      trainableBlockId: trainableBlock.id,
      residualBlocks: blocks,
    });
    const entry = ModelComparisonSeriesEntrySchema.parse({
      schemaVersion: "openpond.modelComparisonSeriesEntry.v1",
      id: `comparison_entry_${contentHash([series.id, scheduled.id, release.selectionHash]).slice(0, 24)}`,
      seriesId: series.id,
      profileId: series.profileId,
      modelProjectId: series.modelProjectId,
      scheduleEntryId: scheduled.id,
      releaseHash,
      ordinal: scheduled.ordinal,
      label: scheduled.label,
      role: scheduled.role,
      branch: scheduled.role === "weekly_rollup" ? "weekly_rollup" : scheduled.role === "full_refresh" ? "full_refresh" : "daily",
      status: "ready",
      parent,
      taskset: exactRef(release.taskset),
      sourceTasksets: release.sourceTasksets,
      taskSelection: release.selection,
      trainableRank: scheduled.trainableRank,
      serializedEnvelopeRank: series.residualProfile.serializedEnvelopeRank,
      enabledCumulativeRank: blocks.at(-1)!.offsetEnd,
      trainableBlockId: trainableBlock.id,
      residualBlocks: blocks,
      attemptOrdinal: 1,
      priorRunAttempts: [],
      trainingPlanId: null,
      modelRunId: null,
      modelVersionId: null,
      evaluations: [],
      decision: null,
      promotionBindingId: null,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const updatedSeries = ModelComparisonSeriesSchema.parse({
      ...series,
      revision: series.revision + 1,
      updatedAt: timestamp,
    });
    return store.commitModelComparisonSeriesMutation({
      expectedSeriesRevision: series.revision,
      series: updatedSeries,
      entry,
      expectedEntryStatus: null,
    });
  }

  async function linkRun(input: {
    entryId: string;
    expectedStatus: ModelComparisonEntryStatus;
    status: ModelComparisonEntryStatus;
    trainingPlanId?: string | null;
    modelRunId?: string | null;
    modelVersionId?: string | null;
    evaluations?: ModelComparisonEvaluationLink[];
  }): Promise<ModelComparisonSeriesEntry> {
    const entry = await requireEntry(input.entryId);
    if (entry.status !== input.expectedStatus) {
      throw new Error(`Comparison entry state changed; expected ${input.expectedStatus} and found ${entry.status}.`);
    }
    if (entry.status !== input.status) requireTransition(entry.status, input.status);
    assertLinkIsAppendOnly(entry, input);
    await verifyLinkedObjects(entry, input);
    if (entry.status === input.status && linkAlreadyRecorded(entry, input)) return entry;
    const timestamp = new Date().toISOString();
    let residualBlocks = entry.residualBlocks;
    if (input.modelVersionId && input.modelVersionId !== entry.modelVersionId) {
      const version = await store.getModelVersion(input.modelVersionId);
      if (!version?.artifactLineageId) throw new Error("A candidate Comparison entry requires a trained Model Version lineage.");
      residualBlocks = entry.residualBlocks.map((block) => block.id === entry.trainableBlockId
        ? { ...block, artifactLineageId: version.artifactLineageId }
        : block);
    }
    const next = ModelComparisonSeriesEntrySchema.parse({
      ...entry,
      status: input.status,
      trainingPlanId: input.trainingPlanId === undefined ? entry.trainingPlanId : input.trainingPlanId,
      modelRunId: input.modelRunId === undefined ? entry.modelRunId : input.modelRunId,
      modelVersionId: input.modelVersionId === undefined ? entry.modelVersionId : input.modelVersionId,
      evaluations: mergeEvaluations(entry.evaluations, input.evaluations),
      residualBlocks,
      queuedAt: input.status === "queued" ? (entry.queuedAt ?? timestamp) : entry.queuedAt,
      startedAt: input.status === "running" ? (entry.startedAt ?? timestamp) : entry.startedAt,
      completedAt: terminalEntryStatus(input.status) ? timestamp : entry.completedAt,
      updatedAt: timestamp,
    });
    return store.compareAndSwapModelComparisonSeriesEntry({ expectedStatus: input.expectedStatus, entry: next });
  }

  async function retryEntry(input: { entryId: string }): Promise<ModelComparisonSeriesEntry> {
    const entry = await requireEntry(input.entryId);
    if (entry.status !== "failed" && entry.status !== "cancelled") {
      throw new Error("Only a failed or cancelled Comparison entry can be retried.");
    }
    if (entry.modelRunId) {
      const run = await store.getModelRun(entry.modelRunId);
      if (!run || (run.status !== "failed" && run.status !== "cancelled")) {
        throw new Error("The current Comparison Run must be terminal before retrying its release.");
      }
    }
    const timestamp = new Date().toISOString();
    const hasAttempt = Boolean(entry.modelRunId || entry.trainingPlanId);
    const priorRunAttempts = hasAttempt
      ? [...entry.priorRunAttempts, {
          attemptOrdinal: entry.attemptOrdinal,
          trainingPlanId: entry.trainingPlanId,
          modelRunId: entry.modelRunId,
          terminalStatus: entry.status,
          queuedAt: entry.queuedAt,
          startedAt: entry.startedAt,
          completedAt: entry.completedAt ?? timestamp,
        }]
      : entry.priorRunAttempts;
    const next = ModelComparisonSeriesEntrySchema.parse({
      ...entry,
      status: "ready",
      attemptOrdinal: hasAttempt ? entry.attemptOrdinal + 1 : entry.attemptOrdinal,
      priorRunAttempts,
      trainingPlanId: null,
      modelRunId: null,
      modelVersionId: null,
      evaluations: [],
      decision: null,
      promotionBindingId: null,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    });
    return store.compareAndSwapModelComparisonSeriesEntry({
      expectedStatus: entry.status,
      entry: next,
    });
  }

  async function decide(input: {
    entryId: string;
    expectedSeriesRevision: number;
    decision: ModelComparisonDecision;
  }): Promise<{ series: ModelComparisonSeries; entry: ModelComparisonSeriesEntry }> {
    const decision = ModelComparisonDecisionSchema.parse(input.decision);
    const entry = await requireEntry(input.entryId);
    const series = await requireSeries(entry.seriesId);
    requireRevision(series, input.expectedSeriesRevision);
    if (entry.status !== "candidate" && !(entry.status === "no_signal" && decision.disposition === "no_signal")) {
      throw new Error("Only a candidate or no-signal entry can receive an advancement decision.");
    }
    if (decision.policy.id !== series.advancementPolicy.id || decision.policy.version !== series.advancementPolicy.version) {
      throw new Error("The decision does not reference the sealed branch-advancement policy.");
    }
    if (decision.disposition === "advance" && !entry.modelVersionId) {
      throw new Error("A Comparison Series cannot advance an entry without a Model Version.");
    }
    const status: ModelComparisonEntryStatus = decision.disposition === "advance"
      ? "accepted"
      : decision.disposition === "hold" ? "rejected" : "no_signal";
    const updatedEntry = ModelComparisonSeriesEntrySchema.parse({
      ...entry,
      status,
      decision,
      completedAt: entry.completedAt ?? decision.decidedAt,
      updatedAt: decision.decidedAt,
    });
    const updatedSeries = ModelComparisonSeriesSchema.parse({
      ...series,
      revision: series.revision + 1,
      acceptedSeedEntryId: decision.disposition === "advance" && entry.role === "seed"
        ? entry.id : series.acceptedSeedEntryId,
      acceptedDailyHeadEntryId: decision.disposition === "advance"
        && (entry.role === "seed" || entry.role === "daily_residual")
        ? entry.id : series.acceptedDailyHeadEntryId,
      updatedAt: decision.decidedAt,
    });
    return store.commitModelComparisonSeriesMutation({
      expectedSeriesRevision: series.revision,
      series: updatedSeries,
      entry: updatedEntry,
      expectedEntryStatus: entry.status,
    });
  }

  async function recordPromotion(input: {
    entryId: string;
    bindingId: string;
    expectedSeriesRevision: number;
  }): Promise<{ series: ModelComparisonSeries; entry: ModelComparisonSeriesEntry }> {
    const entry = await requireEntry(input.entryId);
    const series = await requireSeries(entry.seriesId);
    requireRevision(series, input.expectedSeriesRevision);
    if (entry.status !== "accepted" || !entry.modelVersionId) {
      throw new Error("Only an accepted entry with a Model Version can become Master.");
    }
    const binding = await store.getModelBinding(input.bindingId);
    if (!binding || binding.status !== "active" || binding.role !== series.productionBinding.role
      || binding.roleTargetId !== series.productionBinding.roleTargetId
      || binding.profileId !== series.profileId) {
      throw new Error("The supplied active Model Binding does not match this series' Master target.");
    }
    const version = await store.getModelVersion(entry.modelVersionId);
    if (!version?.artifactLineageId || !sameEntryRef(version.comparisonSeriesEntry, entryRef(entry))
      || binding.modelArtifactLineageId !== version.artifactLineageId) {
      throw new Error("The active Model Binding does not point to the selected entry's artifact lineage.");
    }
    const timestamp = new Date().toISOString();
    const nextEntry = ModelComparisonSeriesEntrySchema.parse({ ...entry, promotionBindingId: binding.id, updatedAt: timestamp });
    const nextSeries = ModelComparisonSeriesSchema.parse({
      ...series,
      revision: series.revision + 1,
      promotedBindingId: binding.id,
      updatedAt: timestamp,
    });
    return store.commitModelComparisonSeriesMutation({
      expectedSeriesRevision: series.revision,
      series: nextSeries,
      entry: nextEntry,
      expectedEntryStatus: entry.status,
    });
  }

  async function reconcileEntries(): Promise<void> {
    const [entries, runs, jobs] = await Promise.all([
      store.listModelComparisonSeriesEntries(),
      store.listModelRuns(),
      store.listTrainingJobs(),
    ]);
    const runsByEntry = new Map<string, typeof runs>();
    for (const run of runs) {
      const reference = run.comparisonSeriesEntry;
      if (!reference) continue;
      const candidates = runsByEntry.get(reference.entryId) ?? [];
      candidates.push(run);
      runsByEntry.set(reference.entryId, candidates);
    }
    for (const initial of entries) {
      if (["accepted", "rejected", "no_signal", "failed", "cancelled"].includes(initial.status)) continue;
      const referencedRuns = (runsByEntry.get(initial.id) ?? [])
        .filter((run) => sameEntryRef(run.comparisonSeriesEntry, entryRef(initial)));
      const linkedRun = initial.modelRunId
        ? referencedRuns.find((run) => run.id === initial.modelRunId) ?? await store.getModelRun(initial.modelRunId)
        : referencedRuns.find((run) => ["prepared", "running", "succeeded"].includes(run.status)) ?? null;
      if (!linkedRun) continue;
      if (!sameEntryRef(linkedRun.comparisonSeriesEntry, entryRef(initial))) {
        throw new Error(`Model Run ${linkedRun.id} does not match Comparison entry ${initial.id}.`);
      }
      let entry = initial;
      if (entry.status === "ready") {
        const job = jobs.find((candidate) => candidate.metadata.modelRunId === linkedRun.id) ?? null;
        entry = await linkRun({
          entryId: entry.id,
          expectedStatus: "ready",
          status: "queued",
          trainingPlanId: job?.planId,
          modelRunId: linkedRun.id,
        });
      }
      if (linkedRun.status === "prepared") continue;
      if (linkedRun.status === "running") {
        if (entry.status === "queued") {
          await linkRun({ entryId: entry.id, expectedStatus: "queued", status: "running" });
        }
        continue;
      }
      if (linkedRun.status === "failed" || linkedRun.status === "cancelled") {
        if (entry.status === "queued" || entry.status === "running") {
          await linkRun({ entryId: entry.id, expectedStatus: entry.status, status: linkedRun.status });
        }
        continue;
      }
      if (linkedRun.status !== "succeeded") continue;
      if (entry.status === "queued") {
        entry = await linkRun({ entryId: entry.id, expectedStatus: "queued", status: "running" });
      }
      if (entry.status !== "running") continue;
      const version = await store.getModelVersion(linkedRun.modelVersionId);
      await linkRun({
        entryId: entry.id,
        expectedStatus: "running",
        status: version?.adapterStatus === "trained" ? "candidate" : "no_signal",
        modelVersionId: version?.adapterStatus === "trained" ? version.id : undefined,
      });
    }
  }

  async function resolveTaskRelease(
    series: ModelComparisonSeries,
    scheduled: ModelComparisonScheduleEntry,
    selectionInput: ReturnType<typeof ModelComparisonQueueReleaseRequestSchema.parse>["taskSelection"],
  ): Promise<{
    taskset: Taskset;
    sourceTasksets: Array<{ id: string; revision: number; contentHash: string }>;
    selection: ModelComparisonTaskSelection | null;
    selectionHash: string;
    reviewedAt: string | null;
    taskCount: number;
  }> {
    if (scheduled.taskSource === "seed_taskset") {
      if (selectionInput) throw new Error("The seed release uses the sealed seed Taskset and does not accept a nightly selection.");
      const taskset = await requireExactTaskset(series.seedTaskset, series.profileId);
      return { taskset, sourceTasksets: [series.seedTaskset], selection: null,
        selectionHash: contentHash(series.seedTaskset), reviewedAt: null,
        taskCount: taskset.tasks.filter((task) => task.split === "train").length };
    }
    if (scheduled.taskSource === "nightly_selection") {
      if (!selectionInput) throw new Error("A daily residual release requires a reviewed task selection.");
      if (!sameRef(selectionInput.sourceTaskset, series.eligibleTaskPool)) {
        throw new Error("The selected evidence does not come from the sealed eligible Taskset.");
      }
      const source = await requireExactTaskset(series.eligibleTaskPool, series.profileId);
      const selected = selectedTasks(source, selectionInput.taskIds);
      const derivedFamilyKeys = [...new Set(selected.map(requireFamilyKey))].sort();
      await assertUnusedFamilies(series.id, derivedFamilyKeys);
      const selectionHash = contentHash({ ...selectionInput, taskIds: [...selectionInput.taskIds].sort(), derivedFamilyKeys });
      const selection = ModelComparisonTaskSelectionSchema.parse({
        ...selectionInput,
        derivedFamilyKeys,
        familyDerivation: { algorithm: "task-cluster-key-v1", sourceTasksetHash: source.contentHash },
        selectionHash,
      });
      const taskset = await materializeTaskset({
        series,
        scheduled,
        template: source,
        tasks: selected,
        sourceTasksets: [series.eligibleTaskPool],
        releaseHash: selectionHash,
        timestamp: selection.reviewedAt,
      });
      return { taskset, sourceTasksets: [series.eligibleTaskPool], selection, selectionHash,
        reviewedAt: selection.reviewedAt, taskCount: selected.length };
    }
    if (selectionInput) throw new Error("Derived comparison releases do not accept client-supplied task selections.");
    if (scheduled.taskSource === "eligible_task_pool") {
      const taskset = await requireExactTaskset(series.eligibleTaskPool, series.profileId);
      const tasks = taskset.tasks.filter((task) => task.split === "train");
      return {
        taskset,
        sourceTasksets: [series.eligibleTaskPool],
        selection: null,
        selectionHash: contentHash(series.eligibleTaskPool),
        reviewedAt: null,
        taskCount: tasks.length,
      };
    }
    const daily = (await store.listModelComparisonSeriesEntries({ seriesId: series.id }))
      .filter((entry) => entry.role === "daily_residual")
      .sort((left, right) => left.ordinal - right.ordinal);
    const expectedDaily = series.schedule.filter((entry) => entry.role === "daily_residual").length;
    if (daily.length !== expectedDaily) throw new Error("Every daily cohort must exist before a weekly union is materialized.");
    const sources = daily.map((entry) => entry.taskset);
    const resolved = await Promise.all(sources.map((reference) => requireExactTaskset(reference, series.profileId)));
    const tasks = uniqueTrainingTasks(resolved);
    const releaseHash = contentHash({ role: scheduled.role, sources });
    const taskset = await materializeTaskset({ series, scheduled, template: resolved[0]!, tasks,
      sourceTasksets: sources, releaseHash, timestamp: new Date().toISOString() });
    return { taskset, sourceTasksets: sources, selection: null, selectionHash: releaseHash,
      reviewedAt: null, taskCount: tasks.length };
  }

  async function resolveParentEntry(
    series: ModelComparisonSeries,
    scheduled: ModelComparisonScheduleEntry,
  ): Promise<ModelComparisonSeriesEntry | null> {
    const id = scheduled.parentRule === "accepted_daily_head"
      ? series.acceptedDailyHeadEntryId
      : scheduled.parentRule === "accepted_seed" ? series.acceptedSeedEntryId : null;
    if (!id) return null;
    const entry = await store.getModelComparisonSeriesEntry(id);
    if (!entry || entry.seriesId !== series.id || entry.status !== "accepted" || !entry.modelVersionId) {
      throw new Error(`The ${scheduled.parentRule} parent is unavailable or invalid.`);
    }
    return entry;
  }

  async function resolveParent(
    series: ModelComparisonSeries,
    scheduled: ModelComparisonScheduleEntry,
    parentEntry: ModelComparisonSeriesEntry | null,
  ): Promise<ModelComparisonParent> {
    if (scheduled.parentRule === "base_model") {
      return { kind: "base_model", id: series.baseModel.id, revision: series.baseModel.revision };
    }
    if (!parentEntry?.modelVersionId) throw new Error(`Release ${scheduled.label} requires its accepted parent.`);
    const version = await store.getModelVersion(parentEntry.modelVersionId);
    if (!version || version.profileId !== series.profileId || version.modelId !== series.modelProjectId) {
      throw new Error("The accepted parent Model Version is unavailable or belongs to another project.");
    }
    if (!sameEntryRef(version.comparisonSeriesEntry, entryRef(parentEntry))) {
      throw new Error("The accepted parent Model Version does not reference the immutable parent release.");
    }
    return { kind: "model_version", id: version.id, contentHash: version.contentHash };
  }

  function buildBlocks(
    series: ModelComparisonSeries,
    scheduled: ModelComparisonScheduleEntry,
    parentEntry: ModelComparisonSeriesEntry | null,
  ): ModelComparisonResidualBlock[] {
    const inherited = scheduled.role === "full_refresh" ? [] : (parentEntry?.residualBlocks ?? [])
      .map((block) => ({ ...block, optimizationRole: "frozen" as const }));
    const offsetStart = inherited.at(-1)?.offsetEnd ?? 0;
    const block: ModelComparisonResidualBlock = {
      id: `residual_block_${series.id}_${scheduled.id}`,
      branchOrdinal: scheduled.ordinal,
      rank: scheduled.trainableRank,
      offsetStart,
      offsetEnd: offsetStart + scheduled.trainableRank,
      optimizationRole: "trainable",
      artifactLineageId: null,
    };
    if (block.offsetEnd > series.residualProfile.maximumEnabledRank
      || block.offsetEnd > series.residualProfile.serializedEnvelopeRank) {
      throw new Error("The release exceeds the series residual rank envelope.");
    }
    return [...inherited, block];
  }

  async function verifyLinkedObjects(
    entry: ModelComparisonSeriesEntry,
    input: Parameters<typeof linkRun>[0],
  ): Promise<void> {
    const expectedEntryRef = entryRef(entry);
    const series = await requireSeries(entry.seriesId);
    if (input.trainingPlanId) {
      const plan = await store.getTrainingPlan(input.trainingPlanId);
      if (!plan || plan.modelId !== entry.modelProjectId
        || plan.tasksetId !== entry.taskset.id || plan.tasksetHash !== entry.taskset.contentHash
        || !sameEntryRef(plan.comparisonSeriesEntry, expectedEntryRef)) {
        throw new Error("The linked Training Plan does not match the immutable series release.");
      }
    }
    if (input.modelRunId) {
      const run = await store.getModelRun(input.modelRunId);
      if (!run || run.profileId !== entry.profileId || run.modelId !== entry.modelProjectId
        || !sameRef(run.taskset, entry.taskset)
        || !sameEntryRef(run.comparisonSeriesEntry, expectedEntryRef)) {
        throw new Error("The linked Model Run does not match the immutable series release.");
      }
    }
    if (input.modelVersionId) {
      const version = await store.getModelVersion(input.modelVersionId);
      if (!version || version.profileId !== entry.profileId || version.modelId !== entry.modelProjectId
        || !sameRef(version.taskset, entry.taskset)
        || !sameEntryRef(version.comparisonSeriesEntry, expectedEntryRef)) {
        throw new Error("The linked Model Version does not match the immutable series release.");
      }
    }
    for (const evaluation of input.evaluations ?? []) {
      if (!sameImmutableRef(evaluation.grader, series.grader)
        || !await evaluationTasksetIsAllowed(series, entry, evaluation)) {
        throw new Error("A linked Evaluation does not match the series grader or declared cohort release.");
      }
      const run = await store.getModelRun(evaluation.evaluationRunId);
      if (!run || run.kind !== "evaluation" || run.modelVersionId !== evaluation.modelVersionId
        || !sameRef(run.taskset, evaluation.taskset)
        || !sameEntryRef(run.comparisonSeriesEntry, expectedEntryRef)) {
        throw new Error("A linked Evaluation does not match its exact Run identity.");
      }
    }
  }

  async function evaluationTasksetIsAllowed(
    series: ModelComparisonSeries,
    entry: ModelComparisonSeriesEntry,
    evaluation: ModelComparisonEvaluationLink,
  ): Promise<boolean> {
    if (evaluation.cohortRole === "current") return sameRef(evaluation.taskset, entry.taskset);
    if (evaluation.cohortRole === "development") return sameRef(evaluation.taskset, series.evaluationTasksets.development);
    if (evaluation.cohortRole === "retained") return sameRef(evaluation.taskset, series.evaluationTasksets.retained);
    if (evaluation.cohortRole === "frozen_final") return sameRef(evaluation.taskset, series.evaluationTasksets.frozenFinal);
    const prior = await store.listModelComparisonSeriesEntries({ seriesId: series.id });
    return prior.some((candidate) => candidate.ordinal < entry.ordinal && sameRef(candidate.taskset, evaluation.taskset));
  }

  async function assertUnusedFamilies(seriesId: string, families: string[]): Promise<void> {
    const used = new Set((await store.listModelComparisonSeriesEntries({ seriesId }))
      .filter((entry) => entry.role === "daily_residual")
      .flatMap((entry) => entry.taskSelection?.derivedFamilyKeys ?? []));
    const reused = families.filter((family) => used.has(family));
    if (reused.length) throw new Error(`Selected families were already used by an earlier daily release: ${reused.join(", ")}`);
  }

  async function materializeTaskset(input: {
    series: ModelComparisonSeries;
    scheduled: ModelComparisonScheduleEntry;
    template: Taskset;
    tasks: TaskDataRecord[];
    sourceTasksets: Array<{ id: string; revision: number; contentHash: string }>;
    releaseHash: string;
    timestamp: string;
  }): Promise<Taskset> {
    const id = `${input.series.id}-${input.scheduled.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${input.releaseHash.slice(0, 10)}`;
    const taskIds = new Set(input.tasks.map((task) => task.id));
    const unhashed = {
      ...input.template,
      id,
      revision: 1,
      name: `${input.series.name} — ${input.scheduled.label}`,
      objective: `${input.series.objective}\n\nImmutable ${input.scheduled.role} release ${input.scheduled.label}.`,
      status: "ready" as const,
      tasks: input.tasks.map((task) => ({ ...task, split: "train" as const })),
      graderFixtures: input.template.graderFixtures.filter((fixture) => taskIds.has(fixture.taskId)),
      learningSignals: Object.fromEntries(Object.entries(input.template.learningSignals).map(([kind, signals]) => [
        kind,
        (signals as Array<{ taskId?: string | null }>).filter((signal) => !signal.taskId || taskIds.has(signal.taskId)),
      ])) as Taskset["learningSignals"],
      readiness: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      metadata: {
        ...input.template.metadata,
        comparisonSeriesRelease: {
          seriesId: input.series.id,
          scheduleEntryId: input.scheduled.id,
          label: input.scheduled.label,
          role: input.scheduled.role,
          sourceTasksets: input.sourceTasksets,
          releaseHash: input.releaseHash,
        },
      },
    };
    const candidate = { ...unhashed, contentHash: computeTasksetHash(unhashed) };
    const existing = await store.getTaskset(id);
    if (existing) {
      if (existing.contentHash !== candidate.contentHash || existing.profileId !== input.series.profileId) {
        throw new Error(`Immutable Comparison release ${id} already exists with different content.`);
      }
      return existing;
    }
    return store.upsertTaskset(candidate);
  }

  async function requireSeries(id: string): Promise<ModelComparisonSeries> {
    const series = await store.getModelComparisonSeries(id);
    if (!series) throw new Error("Model Comparison Series not found.");
    return series;
  }
  async function requireEntry(id: string): Promise<ModelComparisonSeriesEntry> {
    const entry = await store.getModelComparisonSeriesEntry(id);
    if (!entry) throw new Error("Model Comparison Series Entry not found.");
    return entry;
  }
  async function requireExactTaskset(reference: { id: string; revision: number; contentHash: string }, profileId: string): Promise<Taskset> {
    const taskset = await store.getTasksetRevision(reference.id, reference.revision, reference.contentHash)
      ?? await store.getTaskset(reference.id);
    if (!taskset || taskset.profileId !== profileId || !sameRef(taskset, reference)) {
      throw new Error(`Comparison Series Taskset ${reference.id} is unavailable or does not match its immutable reference.`);
    }
    return taskset;
  }
  async function requireSeriesTasksets(series: ModelComparisonSeries): Promise<void> {
    const tasksets = await Promise.all([
      series.seedTaskset,
      series.eligibleTaskPool,
      series.evaluationTasksets.development,
      series.evaluationTasksets.retained,
      series.evaluationTasksets.frozenFinal,
    ].map((reference) => requireExactTaskset(reference, series.profileId)));
    for (const taskset of tasksets) {
      const grader = taskset.graders.find((candidate) => candidate.id === series.grader.id);
      if (!grader || contentHash(grader) !== series.grader.contentHash) {
        throw new Error(`Taskset ${taskset.id} does not resolve the sealed Comparison Series grader release.`);
      }
    }
  }

  return { decide, linkRun, queueRelease, reconcileEntries, recordPromotion, retryEntry, saveSeries, sealSeries };
}

function requireScheduledEntry(series: ModelComparisonSeries, id: string): ModelComparisonScheduleEntry {
  const scheduled = series.schedule.find((entry) => entry.id === id);
  if (!scheduled) throw new Error("The requested schedule entry does not belong to this series.");
  return scheduled;
}
function requireRevision(series: ModelComparisonSeries, expectedRevision: number): void {
  if (series.revision !== expectedRevision) throw new Error(`Comparison Series revision changed; expected ${expectedRevision} and found ${series.revision}.`);
}
function requireTransition(from: ModelComparisonEntryStatus, to: ModelComparisonEntryStatus): void {
  if (from === to || !TRANSITIONS[from].has(to)) throw new Error(`Invalid Comparison entry transition: ${from} -> ${to}.`);
}
function terminalEntryStatus(status: ModelComparisonEntryStatus): boolean {
  return ["candidate", "accepted", "rejected", "no_signal", "failed", "cancelled"].includes(status);
}
function exactRef(taskset: Taskset): { id: string; revision: number; contentHash: string } {
  return { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
}
function entryRef(entry: ModelComparisonSeriesEntry) {
  return {
    seriesId: entry.seriesId,
    entryId: entry.id,
    scheduleEntryId: entry.scheduleEntryId,
    ordinal: entry.ordinal,
    releaseHash: entry.releaseHash,
  };
}
function sameEntryRef(
  left: ReturnType<typeof entryRef> | null | undefined,
  right: ReturnType<typeof entryRef>,
): boolean {
  return Boolean(left
    && left.seriesId === right.seriesId
    && left.entryId === right.entryId
    && left.scheduleEntryId === right.scheduleEntryId
    && left.ordinal === right.ordinal
    && left.releaseHash === right.releaseHash);
}
function assertLinkIsAppendOnly(
  entry: ModelComparisonSeriesEntry,
  input: {
    trainingPlanId?: string | null;
    modelRunId?: string | null;
    modelVersionId?: string | null;
  },
): void {
  for (const [label, current, proposed] of [
    ["Training Plan", entry.trainingPlanId, input.trainingPlanId],
    ["Model Run", entry.modelRunId, input.modelRunId],
    ["Model Version", entry.modelVersionId, input.modelVersionId],
  ] as const) {
    if (proposed === null && current !== null) throw new Error(`${label} linkage cannot be cleared.`);
    if (proposed !== undefined && proposed !== null && current !== null && proposed !== current) {
      throw new Error(`${label} linkage is immutable once recorded.`);
    }
  }
}
function mergeEvaluations(
  current: ModelComparisonEvaluationLink[],
  incoming: ModelComparisonEvaluationLink[] | undefined,
): ModelComparisonEvaluationLink[] {
  if (!incoming) return current;
  const byRun = new Map(current.map((evaluation) => [evaluation.evaluationRunId, evaluation]));
  for (const evaluation of incoming) {
    const existing = byRun.get(evaluation.evaluationRunId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(evaluation)) {
      throw new Error(`Evaluation ${evaluation.evaluationRunId} cannot be relinked with different evidence.`);
    }
    byRun.set(evaluation.evaluationRunId, evaluation);
  }
  return [...byRun.values()];
}
function linkAlreadyRecorded(
  entry: ModelComparisonSeriesEntry,
  input: {
    trainingPlanId?: string | null;
    modelRunId?: string | null;
    modelVersionId?: string | null;
    evaluations?: ModelComparisonEvaluationLink[];
  },
): boolean {
  const matches = (proposed: string | null | undefined, current: string | null) =>
    proposed === undefined || proposed === current;
  if (!matches(input.trainingPlanId, entry.trainingPlanId)
    || !matches(input.modelRunId, entry.modelRunId)
    || !matches(input.modelVersionId, entry.modelVersionId)) return false;
  const current = new Map(entry.evaluations.map((evaluation) => [evaluation.evaluationRunId, evaluation]));
  return (input.evaluations ?? []).every((evaluation) =>
    JSON.stringify(current.get(evaluation.evaluationRunId)) === JSON.stringify(evaluation));
}
function sameRef(left: { id: string; revision: number; contentHash: string }, right: { id: string; revision: number; contentHash: string }): boolean {
  return left.id === right.id && left.revision === right.revision && left.contentHash === right.contentHash;
}
function sameImmutableRef(left: { id: string; contentHash: string }, right: { id: string; contentHash: string }): boolean {
  return left.id === right.id && left.contentHash === right.contentHash;
}
function selectedTasks(taskset: Taskset, taskIds: string[]): TaskDataRecord[] {
  const unique = new Set(taskIds);
  if (unique.size !== taskIds.length) throw new Error("A task selection cannot contain duplicate task IDs.");
  const byId = new Map(taskset.tasks.map((task) => [task.id, task]));
  const selected = taskIds.map((id) => byId.get(id));
  if (selected.some((task) => !task)) throw new Error("Every selected task must exist in the exact source Taskset release.");
  return selected as TaskDataRecord[];
}
function requireFamilyKey(task: TaskDataRecord): string {
  const key = task.clusterKey || (typeof task.metadata.scenarioFamily === "string" ? task.metadata.scenarioFamily : "");
  if (!key.trim()) throw new Error(`Task ${task.id} has no server-verifiable family key.`);
  return key.trim();
}
function uniqueTrainingTasks(tasksets: Taskset[]): TaskDataRecord[] {
  const tasks = new Map<string, TaskDataRecord>();
  for (const taskset of tasksets) for (const task of taskset.tasks.filter((candidate) => candidate.split === "train")) {
    const existing = tasks.get(task.id);
    if (existing && contentHash(existing) !== contentHash(task)) throw new Error(`Task ${task.id} has conflicting immutable definitions across union sources.`);
    tasks.set(task.id, task);
  }
  return [...tasks.values()];
}
