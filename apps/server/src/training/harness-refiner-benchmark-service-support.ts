import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ModelRunSchema,
  type HarnessImprovementProposal,
  type HarnessTargetedValidationReceipt,
  type ModelRun,
} from "@openpond/contracts";
import {
  ArtifactManifestSchema,
  AttemptReceiptContentSchema,
  AttemptReceiptSchema,
  RewardReceiptSchema,
  aggregateEvaluationReceipts,
  createBenchmarkRunSummary,
  verifyArtifactManifest,
  verifyRewardReceipt,
  type ArtifactManifest,
  type AttemptReceipt,
  type BenchmarkComparison,
  type BenchmarkRunSummary,
  type RewardReceipt,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import type { SqliteStore } from "../store/store.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import {
  BenchmarkEvidenceSnapshot,
  FrozenToolEvidenceExhaustedError,
  type BenchmarkEvidenceSnapshotManifest,
  type FrozenToolObservation,
  type HarnessRefinerExecutionPlanItem,
  type SequentialAdaptationStep,
} from "./harness-refiner-benchmark-protocol.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;
export type EvaluationAttempt = Awaited<ReturnType<Evaluation["execute"]>>;
type StoredTaskAttempt = Awaited<ReturnType<SqliteStore["listTaskAttempts"]>>[number];
type StoredGradeResult = Awaited<ReturnType<SqliteStore["listGradeResultsForTaskset"]>>[number];
type StoredTaskArtifact = Awaited<ReturnType<SqliteStore["listTaskAttemptArtifacts"]>>[number];

export type BenchmarkAttemptEvidence = {
  attempt: StoredTaskAttempt;
  grade: StoredGradeResult;
  artifacts: StoredTaskArtifact[];
  receiptContentHash: string;
  artifactManifest: ArtifactManifest;
  rewardReceipt: RewardReceipt;
};

export type CompletedBenchmarkStage = {
  run: BenchmarkRunSummary;
  attempts: BenchmarkAttemptEvidence[];
};

export type BenchmarkLineage = {
  adaptationEvidenceHash: string;
  refinerInputHash: string;
  refinerOutcomeHash: string;
  validationHash: string;
  applyReceiptHash: string;
  candidateRelease: { id: string; contentHash: string };
  valid: boolean;
};

export function completedStage(input: {
  run: BenchmarkRunSummary;
  attempts: EvaluationAttempt[];
}): CompletedBenchmarkStage {
  return {
    run: input.run,
    attempts: input.attempts.map((result) => ({
      attempt: result.attempt,
      grade: result.grade,
      artifacts: result.artifacts,
      receiptContentHash: result.portable.receipt.contentHash,
      artifactManifest: result.portable.artifactManifest,
      rewardReceipt: result.portable.rewardReceipt,
    })),
  };
}

function attemptKey(attempt: Pick<StoredTaskAttempt, "taskId" | "seed" | "attempt">) {
  return `${attempt.taskId}\u0000${attempt.seed}\u0000${attempt.attempt}`;
}

function rebaseAttemptReceipt(
  receipt: AttemptReceipt,
  runManifest: { id: string; contentHash: string },
): AttemptReceipt {
  const { contentHash: _priorHash, ...priorCore } = AttemptReceiptSchema.parse(receipt);
  const core = AttemptReceiptContentSchema.parse({
    ...priorCore,
    runManifest,
  });
  return AttemptReceiptSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

export async function combineRetriedBenchmarkStage(input: {
  store: SqliteStore;
  tasksetId: string;
  parentModelRunId: string;
  prior: CompletedBenchmarkStage;
  retries: EvaluationAttempt[];
  createdAt: string;
}): Promise<CompletedBenchmarkStage> {
  if (!input.retries.length) return input.prior;
  const manifest = input.retries[0]!.portable.runManifest;
  const retryByAttempt = new Map(input.retries.map((result) => [
    attemptKey(result.attempt),
    {
      evidence: {
        attempt: result.attempt,
        grade: result.grade,
        artifacts: result.artifacts,
        receiptContentHash: result.portable.receipt.contentHash,
        artifactManifest: result.portable.artifactManifest,
        rewardReceipt: result.portable.rewardReceipt,
      },
      receipt: result.portable.receipt,
    },
  ]));
  const combined = input.prior.attempts.map((prior) => {
    const retry = retryByAttempt.get(attemptKey(prior.attempt));
    const priorReceipt = AttemptReceiptSchema.parse(
      prior.attempt.metadata.portableAttemptReceipt,
    );
    return retry ?? { evidence: prior, receipt: priorReceipt };
  });
  if (combined.length !== input.prior.run.attemptCount) {
    throw new Error("Retried benchmark evidence changed the admitted attempt count.");
  }
  const receipts = combined.map(({ receipt }) => rebaseAttemptReceipt(receipt, {
    id: manifest.id,
    contentHash: manifest.contentHash,
  }));
  const evaluation = aggregateEvaluationReceipts({
    id: `benchmark-evaluation-${contentHash({
      manifest: manifest.contentHash,
      phase: input.prior.run.phase,
      receipts: receipts.map((receipt) => receipt.contentHash),
    }).slice(0, 24)}`,
    manifest,
    receipts,
    metadata: {
      kind: "benchmark",
      phase: input.prior.run.phase,
      split: input.prior.run.protocol.split,
      reasoningEffort: input.prior.run.reasoningEffort,
      sourceTasksetId: input.tasksetId,
      benchmarkDefinitionId: "harness-refiner",
      parentModelRunId: input.parentModelRunId,
      recoveredInfrastructureAttempts: input.retries.length,
    },
  });
  await input.store.saveEvaluationResult({
    tasksetId: input.tasksetId,
    kind: input.prior.run.phase,
    result: evaluation,
    createdAt: input.createdAt,
  });
  const run = createBenchmarkRunSummary({
    id: `benchmark-run-${evaluation.contentHash.slice(0, 24)}`,
    phase: input.prior.run.phase,
    evaluation,
    receipts,
    reasoningEffort: input.prior.run.reasoningEffort,
    protocol: input.prior.run.protocol,
    createdAt: input.createdAt,
    metadata: {
      ...input.prior.run.metadata,
      recoveredInfrastructureAttempts: input.retries.length,
    },
  });
  await input.store.saveBenchmarkRun({ tasksetId: input.tasksetId, run });
  return {
    run,
    attempts: combined.map(({ evidence }) => evidence),
  };
}

export async function loadCompletedBenchmarkStage(input: {
  store: SqliteStore;
  modelRunId: string;
  tasksetId: string;
  plan: HarnessRefinerExecutionPlanItem;
}): Promise<CompletedBenchmarkStage> {
  const [runs, attempts, grades] = await Promise.all([
    input.store.listBenchmarkRuns(input.tasksetId),
    input.store.listTaskAttempts(input.tasksetId),
    input.store.listGradeResultsForTaskset(input.tasksetId),
  ]);
  const phase = input.plan.stage === "baseline" || input.plan.stage === "adaptation"
    ? "baseline"
    : "candidate";
  const run = runs.find((candidate) =>
    candidate.metadata.parentModelRunId === input.modelRunId
    && candidate.phase === phase
    && candidate.protocol.split === input.plan.split
    && contentHash(candidate.protocol.taskIds) === contentHash(input.plan.taskIds)
  );
  if (!run) {
    throw new Error(`Completed ${input.plan.stage} benchmark evidence is unavailable.`);
  }
  const taskOrder = new Map(input.plan.taskIds.map((taskId, index) => [taskId, index]));
  const selectedByKey = new Map<string, StoredTaskAttempt>();
  for (const attempt of attempts) {
    if (
      attempt.metadata.parentModelRunId === input.modelRunId
      && taskOrder.has(attempt.taskId)
      && attemptHarnessReleaseHash(attempt) === run.harnessRelease.contentHash
    ) {
      selectedByKey.set(attemptKey(attempt), attempt);
    }
  }
  const selected = [...selectedByKey.values()]
    .sort((left, right) =>
      (taskOrder.get(left.taskId) ?? 0) - (taskOrder.get(right.taskId) ?? 0)
      || left.seed - right.seed
      || left.attempt - right.attempt
    );
  if (selected.length !== input.plan.attemptCount) {
    throw new Error(
      `Completed ${input.plan.stage} evidence has ${selected.length}/${input.plan.attemptCount} attempts.`,
    );
  }
  const gradesByAttempt = new Map(grades.map((grade) => [grade.attemptId, grade]));
  const evidence = await Promise.all(selected.map(async (attempt) => {
    const grade = gradesByAttempt.get(attempt.id);
    if (!grade) throw new Error(`Attempt ${attempt.id} has no durable grade.`);
    return {
      attempt,
      grade,
      artifacts: await input.store.listTaskAttemptArtifacts({ attemptId: attempt.id }),
      receiptContentHash: portableReceiptContentHash(attempt),
      ...portableCanonicalReceipts(attempt),
    };
  }));
  return { run, attempts: evidence };
}

export async function loadBenchmarkAttemptEvidenceByIds(input: {
  store: SqliteStore;
  tasksetId: string;
  attemptIds: readonly string[];
}): Promise<BenchmarkAttemptEvidence[]> {
  const wanted = new Set(input.attemptIds);
  const [attempts, grades] = await Promise.all([
    input.store.listTaskAttempts(input.tasksetId),
    input.store.listGradeResultsForTaskset(input.tasksetId),
  ]);
  const selected = attempts.filter((attempt) => wanted.has(attempt.id));
  if (selected.length !== wanted.size) {
    throw new Error(
      `Sequential adaptation evidence has ${selected.length}/${wanted.size} attempts.`,
    );
  }
  const selectedById = new Map(selected.map((attempt) => [attempt.id, attempt]));
  const gradesByAttempt = new Map(grades.map((grade) => [grade.attemptId, grade]));
  return Promise.all(input.attemptIds.map(async (attemptId) => {
    const attempt = selectedById.get(attemptId);
    if (!attempt) throw new Error(`Sequential adaptation attempt ${attemptId} is unavailable.`);
    const grade = gradesByAttempt.get(attempt.id);
    if (!grade) throw new Error(`Attempt ${attempt.id} has no durable grade.`);
    return {
      attempt,
      grade,
      artifacts: await input.store.listTaskAttemptArtifacts({ attemptId: attempt.id }),
      receiptContentHash: portableReceiptContentHash(attempt),
      ...portableCanonicalReceipts(attempt),
    };
  }));
}

function attemptHarnessReleaseHash(attempt: StoredTaskAttempt): string | null {
  const capability = objectRecord(attempt.metadata.harnessCapabilityReceipt);
  const release = objectRecord(capability?.harnessRelease);
  return typeof release?.contentHash === "string" ? release.contentHash : null;
}

function portableReceiptContentHash(attempt: StoredTaskAttempt): string {
  const receipt = objectRecord(attempt.metadata.portableAttemptReceipt);
  const hash = receipt?.contentHash;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Attempt ${attempt.id} has no durable portable receipt.`);
  }
  return hash;
}

function portableCanonicalReceipts(attempt: StoredTaskAttempt): {
  artifactManifest: ArtifactManifest;
  rewardReceipt: RewardReceipt;
} {
  try {
    const artifactManifest = ArtifactManifestSchema.parse(
        attempt.metadata.portableArtifactManifest,
      );
    const rewardReceipt = RewardReceiptSchema.parse(
        attempt.metadata.portableRewardReceipt,
      );
    if (!verifyArtifactManifest(artifactManifest) || !verifyRewardReceipt(rewardReceipt)) {
      throw new Error("Canonical reward evidence failed content-hash verification.");
    }
    return { artifactManifest, rewardReceipt };
  } catch (error) {
    throw new Error(
      `Attempt ${attempt.id} has no valid durable canonical reward evidence.`,
      { cause: error },
    );
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function releasedHarness(record: {
  agentSnapshot: import("@openpond/harness").AgentSnapshot;
  harnessRelease: import("@openpond/harness").HarnessRelease;
}, instructionContext?: string) {
  return {
    agentSnapshot: record.agentSnapshot,
    harnessRelease: record.harnessRelease,
    instructionContext,
  };
}

export function stringMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function taskPrompt(task: { input: Record<string, unknown> }): string {
  if (typeof task.input.prompt === "string" && task.input.prompt.trim()) {
    return task.input.prompt;
  }
  const messages = Array.isArray(task.input.messages) ? task.input.messages : [];
  return messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const content = (message as Record<string, unknown>).content;
      return typeof content === "string" && content.trim() ? [content] : [];
    })
    .join("\n\n");
}

export async function requireModelProject(
  store: SqliteStore,
  modelId: string,
  profileId: string,
) {
  const project = await store.getModelProject(modelId);
  if (!project || project.profileId !== profileId) {
    throw new Error("A Model in the active Profile is required.");
  }
  return project;
}

export async function updateProgress(
  store: SqliteStore,
  modelRunId: string,
  progress: Omit<
    NonNullable<ModelRun["evaluationProgress"]>,
    "accounting" | "evidenceSnapshot"
  > & {
    accounting?: EvaluationAccounting;
    evidenceSnapshot?: NonNullable<ModelRun["evaluationProgress"]>["evidenceSnapshot"];
  },
) {
  const run = await store.getModelRun(modelRunId);
  if (!run || run.kind !== "evaluation") {
    throw new Error(`Evaluation Model Run ${modelRunId} is unavailable.`);
  }
  if (run.status !== "running") return run;
  return store.saveModelRun(ModelRunSchema.parse({
    ...run,
    evaluationProgress: {
      ...run.evaluationProgress,
      ...progress,
    },
    updatedAt: new Date().toISOString(),
  }));
}

type EvaluationAccounting = NonNullable<
  NonNullable<ModelRun["evaluationProgress"]>["accounting"]
>;

export function emptyEvaluationAccounting(): EvaluationAccounting {
  return {
    usage: {
      baseline: emptyUsageCategory(),
      adaptation: emptyUsageCategory(),
      candidateAdaptation: emptyUsageCategory(),
      candidate: emptyUsageCategory(),
      refiner: emptyUsageCategory(),
      grader: emptyUsageCategory(),
    },
    observedSpendUsd: 0,
    attempts: [],
  };
}

export async function checkpointAttempt(
  store: SqliteStore,
  modelRunId: string,
  input: {
    stage: HarnessRefinerExecutionPlanItem["stage"];
    completedAttempts: number;
    totalAttempts: number;
    result: EvaluationAttempt;
    grader: EvaluationUsageCategory;
    observedSpendUsd: number;
  },
) {
  const current = await store.getModelRun(modelRunId);
  if (!current || current.status !== "running") return current;
  const accounting = structuredClone(
    current.evaluationProgress?.accounting ?? emptyEvaluationAccounting(),
  );
  const usage = emptyUsageCategory();
  const rawUsage = input.result.attempt.metadata.usage;
  for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
    addUsage(usage, item);
  }
  if (input.result.attempt.costUsd !== null) {
    usage.costUsd = input.result.attempt.costUsd;
  }
  const usageKey = input.stage === "candidate_adaptation"
    ? "candidateAdaptation"
    : input.stage;
  mergeUsage(accounting.usage[usageKey], usage);
  mergeUsage(accounting.usage.grader, input.grader);
  accounting.observedSpendUsd = input.observedSpendUsd;
  const attempt = modelEvaluationAttempts(input.stage, [input.result])[0]!;
  accounting.attempts = [
    ...accounting.attempts.filter((item) => item.attemptId !== attempt.attemptId),
    attempt,
  ];
  return updateProgress(store, modelRunId, {
    stage: input.stage,
    completedAttempts: input.completedAttempts,
    totalAttempts: input.totalAttempts,
    accounting,
  });
}

export async function checkpointRefinerUsage(
  store: SqliteStore,
  modelRunId: string,
  usage: EvaluationUsageCategory,
  observedSpendUsd: number,
) {
  const current = await store.getModelRun(modelRunId);
  if (!current || current.status !== "running" || !current.evaluationProgress) {
    return current;
  }
  const accounting = structuredClone(
    current.evaluationProgress.accounting ?? emptyEvaluationAccounting(),
  );
  mergeUsage(accounting.usage.refiner, usage);
  accounting.observedSpendUsd = observedSpendUsd;
  return updateProgress(store, modelRunId, {
    stage: current.evaluationProgress.stage,
    completedAttempts: current.evaluationProgress.completedAttempts,
    totalAttempts: current.evaluationProgress.totalAttempts,
    accounting,
  });
}

export async function checkpointEvidenceSnapshot(
  store: SqliteStore,
  storeDir: string,
  modelRunId: string,
  snapshot: BenchmarkEvidenceSnapshotManifest,
) {
  const directory = path.join(
    storeDir,
    "training",
    "harness-refiner-benchmarks",
    modelRunId,
  );
  await fs.mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, "evidence-snapshot.json");
  await fs.writeFile(artifactPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const run = await store.getModelRun(modelRunId);
  if (!run || run.status !== "running" || !run.evaluationProgress) return run;
  return store.saveModelRun(ModelRunSchema.parse({
    ...run,
    evaluationProgress: {
      ...run.evaluationProgress,
      evidenceSnapshot: {
        id: snapshot.id,
        contentHash: snapshot.contentHash,
        artifactPath,
      },
    },
    updatedAt: new Date().toISOString(),
  }));
}

export async function loadOrReconstructEvidenceSnapshot(input: {
  store: SqliteStore;
  storeDir: string;
  modelRun: ModelRun;
  attempts: Array<{
    result: BenchmarkAttemptEvidence;
    cohort: "adaptation" | "held_out";
  }>;
}): Promise<BenchmarkEvidenceSnapshot> {
  const ref = input.modelRun.evaluationProgress?.evidenceSnapshot;
  if (ref) {
    const manifest = parseEvidenceSnapshotManifest(
      JSON.parse(await fs.readFile(ref.artifactPath, "utf8")),
    );
    if (manifest.id !== ref.id || manifest.contentHash !== ref.contentHash) {
      throw new Error("Durable benchmark evidence snapshot does not match its admitted ref.");
    }
    return new BenchmarkEvidenceSnapshot(manifest.observations);
  }
  const observations = await reconstructFrozenToolObservations(
    input.store,
    input.attempts,
  );
  const snapshot = new BenchmarkEvidenceSnapshot(observations);
  await checkpointEvidenceSnapshot(
    input.store,
    input.storeDir,
    input.modelRun.id,
    snapshot.manifest(),
  );
  return snapshot;
}

function parseEvidenceSnapshotManifest(value: unknown): BenchmarkEvidenceSnapshotManifest {
  const record = objectRecord(value);
  if (
    record?.schemaVersion !== "openpond.benchmarkEvidenceSnapshot.v1"
    || typeof record.id !== "string"
    || typeof record.contentHash !== "string"
    || !Array.isArray(record.observations)
  ) {
    throw new Error("Durable benchmark evidence snapshot is malformed.");
  }
  const observations = record.observations.map((item) => {
    const observation = objectRecord(item);
    const result = objectRecord(observation?.result);
    if (
      (observation?.cohort !== "adaptation" && observation?.cohort !== "held_out")
      || typeof observation.taskId !== "string"
      || (observation.toolName !== "web_search" && observation.toolName !== "web_fetch")
      || typeof observation.argumentsHash !== "string"
      || !Number.isInteger(observation.ordinal)
      || (observation.ordinal as number) < 0
      || !result
      || typeof result.toolCallId !== "string"
      || typeof result.name !== "string"
      || typeof result.ok !== "boolean"
      || typeof result.contentText !== "string"
    ) {
      throw new Error("Durable benchmark evidence snapshot contains a malformed observation.");
    }
    return observation as FrozenToolObservation;
  });
  const core = {
    schemaVersion: "openpond.benchmarkEvidenceSnapshot.v1" as const,
    id: record.id,
    observations,
  };
  if (contentHash(core) !== record.contentHash) {
    throw new Error("Durable benchmark evidence snapshot failed content-hash validation.");
  }
  return { ...core, contentHash: record.contentHash };
}

async function reconstructFrozenToolObservations(
  store: SqliteStore,
  attempts: Array<{
    result: BenchmarkAttemptEvidence;
    cohort: "adaptation" | "held_out";
  }>,
): Promise<FrozenToolObservation[]> {
  const observations: FrozenToolObservation[] = [];
  for (const { result, cohort } of attempts) {
    const sessionId = stringMetadata(result.attempt.metadata, "sessionId");
    const turnId = stringMetadata(result.attempt.metadata, "turnId");
    if (!sessionId || !turnId) continue;
    const events = (await store.runtimeEventsForSession(sessionId, {
      names: ["tool.started", "tool.completed"],
      limit: 100_000,
    })).filter((entry) => entry.turnId === turnId);
    const started = new Map<string, {
      toolName: "web_search" | "web_fetch";
      args: Record<string, unknown>;
      ordinal: number;
    }>();
    const ordinals = new Map<string, number>();
    for (const entry of events) {
      const data = objectRecord(entry.data);
      const callId = typeof data?.toolCallId === "string" ? data.toolCallId : null;
      const toolName = entry.action === "web_search" || entry.action === "web_fetch"
        ? entry.action
        : null;
      if (!callId || !toolName) continue;
      if (entry.name === "tool.started") {
        const ordinal = ordinals.get(toolName) ?? 0;
        ordinals.set(toolName, ordinal + 1);
        started.set(callId, {
          toolName,
          args: objectRecord(entry.args) ?? {},
          ordinal,
        });
        continue;
      }
      const start = started.get(callId);
      const payload = objectRecord(data?.result);
      if (!start || !payload) continue;
      const ok = typeof payload.ok === "boolean"
        ? payload.ok
        : entry.status === "completed";
      const contentText = typeof payload.output === "string"
        ? payload.output
        : typeof entry.output === "string"
          ? entry.output
          : "";
      const nativeData = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "ok" && key !== "output"),
      );
      observations.push({
        cohort,
        taskId: result.attempt.taskId,
        toolName: start.toolName,
        argumentsHash: contentHash(start.args),
        ordinal: start.ordinal,
        result: {
          toolCallId: callId,
          name: start.toolName,
          ok,
          contentText,
          ...(Object.keys(nativeData).length ? { data: nativeData } : {}),
        },
      });
    }
  }
  return observations;
}

function modelEvaluationAttempts(
  phase: "baseline" | "adaptation" | "candidate_adaptation" | "candidate",
  results: Array<Pick<BenchmarkAttemptEvidence, "attempt" | "grade">>,
) {
  return results.map((result) => {
    const usage = emptyUsageCategory();
    const rawUsage = result.attempt.metadata.usage;
    for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
      addUsage(usage, item);
    }
    return {
      phase,
      taskId: result.attempt.taskId,
      attemptId: result.attempt.id,
      sessionId: stringMetadata(result.attempt.metadata, "sessionId"),
      turnId: stringMetadata(result.attempt.metadata, "turnId"),
      passed: result.grade.passed,
      score: result.grade.score,
      failureClass: result.grade.failureClass,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs: result.attempt.latencyMs,
      costUsd: result.attempt.costUsd,
      startedAt: result.attempt.startedAt,
    };
  });
}

export function attemptUsageSummary(rawUsage: unknown) {
  const usage = emptyUsageCategory();
  for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
    addUsage(usage, item);
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

export function attemptToolFailureCount(
  result: Pick<BenchmarkAttemptEvidence, "attempt">,
): number {
  const value = result.attempt.output.toolFailureCount;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

export async function benchmarkToolFailureEvidence(input: {
  attemptId: string;
  artifacts: Array<Pick<StoredTaskArtifact, "kind" | "path" | "sha256">>;
  expectedCount: number;
}): Promise<{
  failures: Array<{
    toolName: string;
    turn: number | null;
    detail: string;
    recoveredLater: boolean;
  }>;
  omittedCount: number;
}> {
  if (input.expectedCount === 0) return { failures: [], omittedCount: 0 };
  const trace = input.artifacts.find((artifact) => artifact.kind === "runtime_trace");
  if (!trace) {
    throw new Error(`Attempt ${input.attemptId} has tool failures but no runtime trace.`);
  }
  const bytes = await fs.readFile(trace.path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== trace.sha256) {
    throw new Error(`Attempt ${input.attemptId} runtime trace failed hash validation.`);
  }
  const parsed = objectRecord(JSON.parse(bytes.toString("utf8")));
  const steps = Array.isArray(parsed?.steps)
    ? parsed.steps.map((step) => objectRecord(step)).filter(Boolean)
    : [];
  const failures = steps.flatMap((step, index) => {
    if (step?.kind !== "tool" || step.ok !== false) return [];
    const toolName = typeof step.name === "string" && step.name.trim()
      ? step.name.trim()
      : "unknown_tool";
    const recoveredLater = steps.slice(index + 1).some(
      (candidate) => candidate?.kind === "tool"
        && candidate.name === toolName
        && candidate.ok === true,
    );
    return [{
      toolName,
      turn: typeof step.turn === "number" && Number.isInteger(step.turn)
        ? step.turn
        : null,
      detail: typeof step.output === "string"
        ? step.output.slice(0, 1_000)
        : "Tool failed without textual output.",
      recoveredLater,
    }];
  });
  if (failures.length !== input.expectedCount) {
    throw new Error(
      `Attempt ${input.attemptId} tool-failure count drifted between its receipt and runtime trace.`,
    );
  }
  const visible = failures.slice(0, 20);
  return {
    failures: visible,
    omittedCount: failures.length - visible.length,
  };
}

type EvaluationUsageCategory = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export function emptyUsageCategory(): EvaluationUsageCategory {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
}

export function addUsage(
  category: EvaluationUsageCategory,
  usage: unknown,
  costUsd?: number,
) {
  const normalized = normalizeModelUsageTokens(usage);
  category.inputTokens += normalized.promptTokens ?? 0;
  category.outputTokens += normalized.completionTokens ?? 0;
  category.totalTokens += normalized.totalTokens ?? 0;
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
    category.costUsd = (category.costUsd ?? 0) + costUsd;
  }
}

function mergeUsage(
  target: EvaluationUsageCategory,
  source: EvaluationUsageCategory,
) {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  if (source.costUsd !== null) {
    target.costUsd = (target.costUsd ?? 0) + source.costUsd;
  }
}

export function requirePlanStage(
  plan: HarnessRefinerExecutionPlanItem[],
  stage: HarnessRefinerExecutionPlanItem["stage"],
) {
  const item = plan.find((candidate) => candidate.stage === stage);
  if (!item) throw new Error(`Harness Refiner plan is missing ${stage}.`);
  return item;
}

export function frozenToolEvidence(
  snapshot: BenchmarkEvidenceSnapshot,
  mode: "record" | "replay",
  cohort: "adaptation" | "held_out",
) {
  return {
    execute: async (input: {
      taskId: string;
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      execute: () => Promise<import("../openpond/native-tool-calls.js").NativeModelToolResult>;
    }) => {
      try {
        const result = await snapshot.execute({ ...input, mode, cohort });
        return {
          ...result,
          // Frozen evidence preserves the baseline result bytes, not the
          // baseline model's tool-call identity. Candidate turns author fresh
          // call IDs and provider protocols require each replayed tool message
          // to answer those current IDs exactly.
          toolCallId: input.callId,
        };
      } catch (error) {
        if (mode !== "replay" || !(error instanceof FrozenToolEvidenceExhaustedError)) {
          throw error;
        }
        return {
          toolCallId: input.callId,
          name: input.toolName,
          ok: false,
          contentText: JSON.stringify({
            ok: false,
            action: input.toolName,
            output: "The benchmark's frozen external-evidence budget is exhausted for this task.",
            repairHint: "Do not call web tools again. Finish the task using the frozen evidence already returned.",
          }),
        };
      }
    },
  };
}

export async function benchmarkLineage(input: {
  store: SqliteStore;
  workspaceId: string;
  adaptationAttempts: BenchmarkAttemptEvidence[];
  completedSteps: SequentialAdaptationStep[];
  candidateRelease: { id: string; contentHash: string };
  refinerInputHash: string;
}): Promise<BenchmarkLineage> {
  const [outcomes, rawProposals, rawValidations, applyReceipts] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "refiner_outcome",
      1_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "proposal",
      1_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "targeted_validation",
      10_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "apply_receipt",
      1_000,
    ),
  ]);
  const proposals = rawProposals as HarnessImprovementProposal[];
  const validations = rawValidations as HarnessTargetedValidationReceipt[];
  const adaptationEvidenceHash = contentHash(input.adaptationAttempts.map((result) => ({
    attempt: result.attempt.id,
    receipt: result.receiptContentHash,
    grade: contentHash(result.grade),
  })));
  const requiredValidationsPassed = proposals.every((proposal) =>
    proposal.validationPlan
      .filter((plan) => plan.required)
      .every((plan) => validations.some(
        (validation) => validation.validationId === plan.id && validation.status === "passed",
      ))
  );
  const proposalHashes = new Set(
    proposals.map((proposal) => proposal.contentHash),
  );
  const appliedProposalHashes = new Set(applyReceipts.flatMap((artifact) => {
    const proposal = "proposal" in artifact ? artifact.proposal : null;
    return proposal && typeof proposal === "object" && "contentHash" in proposal
      ? [String(proposal.contentHash)]
      : [];
  }));
  const everyProposalHasReceipt = [...proposalHashes].every((hash) =>
    appliedProposalHashes.has(hash)
  );
  return {
    adaptationEvidenceHash,
    refinerInputHash: input.refinerInputHash,
    refinerOutcomeHash: contentHash(outcomes),
    validationHash: contentHash(validations),
    applyReceiptHash: contentHash(applyReceipts),
    candidateRelease: {
      id: input.candidateRelease.id,
      contentHash: input.candidateRelease.contentHash,
    },
    valid:
      outcomes.length === input.completedSteps.filter((step) => step.outcome).length
      && requiredValidationsPassed
      && everyProposalHasReceipt,
  };
}

type AttemptStageSummary = Pick<
  BenchmarkRunSummary,
  "attemptCount" | "passedCount" | "terminalCount"
>;

export function comparisonInvalidReasons(input: {
  baseline: BenchmarkRunSummary;
  adaptation: BenchmarkRunSummary;
  candidateAdaptation: AttemptStageSummary;
  candidate: BenchmarkRunSummary;
  harnessChanged: boolean;
  lineageValid: boolean;
  infrastructureValid: boolean;
}): string[] {
  const reasons: string[] = [];
  for (const [label, run] of [
    ["held-out baseline", input.baseline],
    ["adaptation baseline", input.adaptation],
    ["sequential adaptation treatment", input.candidateAdaptation],
    ["held-out candidate", input.candidate],
  ] as const) {
    if (run.terminalCount !== run.attemptCount) {
      reasons.push(`${label} did not terminalize all admitted attempts.`);
    }
  }
  if (!input.infrastructureValid) {
    reasons.push("At least one attempt has infrastructure-invalid outcome evidence.");
  }
  if (!input.harnessChanged) reasons.push("The candidate Harness is unchanged.");
  if (!input.lineageValid) reasons.push("Candidate Harness lineage is incomplete.");
  if (input.candidateAdaptation.passedCount !== input.candidateAdaptation.attemptCount) {
    reasons.push("Sequential adaptation treatment did not pass every case.");
  }
  if (input.candidate.passedCount !== input.candidate.attemptCount) {
    reasons.push("Candidate held-out quality did not pass every case.");
  }
  return reasons;
}

export function classifyComparison(input: {
  comparison: BenchmarkComparison;
  baseline: BenchmarkRunSummary;
  adaptation: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  candidateAdaptation: AttemptStageSummary;
  harnessChanged: boolean;
  lineageValid: boolean;
  infrastructureValid: boolean;
}): "improved" | "no_improvement" | "regressed" | "inconclusive" | "infrastructure_failure" {
  if (
    !input.infrastructureValid
    ||
    input.baseline.terminalCount !== input.baseline.attemptCount
    || input.adaptation.terminalCount !== input.adaptation.attemptCount
    || input.candidate.terminalCount !== input.candidate.attemptCount
    || input.candidateAdaptation.terminalCount !== input.candidateAdaptation.attemptCount
  ) return "infrastructure_failure";
  if (!input.harnessChanged || !input.lineageValid) return "inconclusive";
  if (
    !input.comparison.qualityPassed
    || input.candidate.passedCount !== input.candidate.attemptCount
    || input.candidateAdaptation.passedCount !== input.candidateAdaptation.attemptCount
  ) return "regressed";
  return input.comparison.improved ? "improved" : "no_improvement";
}

export function modelVersionId(modelId: string) {
  return `model_version_${contentHash({ modelId, version: 0 }).slice(0, 24)}`;
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 5_000) || "Harness Refiner benchmark failed.";
}
