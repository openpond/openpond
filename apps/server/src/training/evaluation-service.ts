import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import {
  BaselineReportSchema,
  GraderAuditReportSchema,
  TaskDataRecordSchema,
  TasksetSchema,
  TaskAttemptResultSchema,
  TasksetBaselineRunSchema,
  type ChatModelRef,
  type DatasetSelectionStrategy,
  type GraderAuditReport,
  type DatasetSplit,
  type TaskDataRecord,
  type TasksetBaselineRun,
} from "@openpond/contracts";
import { buildBaselineReport, buildTaskset, computeTasksetHash, contentHash, gradeAttempt, runBaseline, sha256, type BaselineAttemptRunner, type ModelJudgeRunner } from "@openpond/taskset-sdk";
import { loadOpenPondProfileState } from "@openpond/cloud";
import type { SqliteStore } from "../store/store.js";
import { buildTasksetReadiness } from "./readiness.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";
import { gradeTasksetBaselineAttempt } from "./task-baseline-grade-runner.js";
import type { DatasetProjectionResult } from "./dataset-artifact-service.js";
import type {
  FireworksBaselineDeploymentUpdate,
  FireworksBaselinePrepareOptions,
  PreparedBaselineModels,
} from "./fireworks-baseline-deployment.js";
import { extractFinalAnswer } from "./exact-answer.js";
import { KeyedAdmission } from "./keyed-admission.js";
import {
  artifactSplit,
  auditFlags,
  fixtureAttempt,
  inlineBaselineTasks,
  isActiveBaselineRun,
  summarizeRftSignal,
} from "./evaluation-helpers.js";

const MAX_BASELINE_TASKS = 32;
const MAX_BASELINE_ATTEMPTS_PER_TASK = 8;
const MAX_BASELINE_TOTAL_ATTEMPTS = 256;

type BaselineLifecycle = {
  signal?: AbortSignal;
  onStage?: (
    stage: TasksetBaselineRun["progress"]["stage"],
  ) => Promise<void> | void;
  onScope?: (input: {
    scope: NonNullable<TasksetBaselineRun["scope"]>;
    totalAttempts: number;
  }) => Promise<void> | void;
  onAttemptCompleted?: NonNullable<
    Parameters<typeof runBaseline>[0]["onAttemptCompleted"]
  >;
  onDeploymentUpdate?: (
    update: FireworksBaselineDeploymentUpdate,
  ) => Promise<void> | void;
  onProviderCost?: (costUsd: number | null) => Promise<void> | void;
};

export function createTaskEvaluationService(deps: {
  store: SqliteStore;
  storeDir?: string;
  runAttempt?: BaselineAttemptRunner | null;
  modelJudge?: ModelJudgeRunner | null;
  loadProfileState?: typeof loadOpenPondProfileState;
  resolveTask?: (input: {
    tasksetId: string;
    taskId: string;
    split?: DatasetSplit | null;
  }) => Promise<TaskDataRecord>;
  projectDatasetArtifact?: (input: {
    tasksetId: string;
    split: "train" | "validation" | "frozen_eval";
    mode: "baseline";
    limit: number;
    seed: number;
    selectionStrategy?: DatasetSelectionStrategy;
    approvedSourceIds: string[];
    outputPath: string;
  }) => Promise<DatasetProjectionResult>;
  prepareBaselineModels?: (
    models: ChatModelRef[],
    options?: FireworksBaselinePrepareOptions,
  ) => Promise<PreparedBaselineModels>;
  cleanupBaselineDeployments?: () => Promise<string[]>;
}) {
  const activeBaselineRuns = new Map<
    string,
    { controller: AbortController; execution: Promise<void> }
  >();
  const baselineStartAdmission = new KeyedAdmission("A baseline run");
  let closing = false;
  const ready = reconcileInterruptedBaselineRuns();

  async function grade(input: { tasksetId: string; taskId: string; attempt: unknown }) {
    const taskset = await requireTaskset(input.tasksetId);
    const attempt = TaskAttemptResultSchema.parse(input.attempt);
    const task = await findTask(taskset, input.taskId, attempt.split);
    const customVerifier = await customVerifierFor(taskset.id);
    const result = await gradeTasksetBaselineAttempt({
      task,
      attempt,
      graders: taskset.graders,
      modelJudge: deps.modelJudge ?? undefined,
      customVerifier,
      now: () => new Date().toISOString(),
    });
    await deps.store.saveTaskAttempt(attempt);
    await deps.store.saveGradeResult(result);
    return result;
  }

  async function baseline(input: {
    tasksetId: string;
    targetModelId?: string | null;
    models: ChatModelRef[];
    seeds?: number[];
    attemptsPerTask?: number;
    taskLimit?: number;
    selectionSeed?: number;
    split?: "train" | "validation" | "frozen_eval";
    selectionStrategy?: DatasetSelectionStrategy;
    sampling?: {
      maxOutputTokens?: number;
      temperature?: number;
      topP?: number;
    };
  }, lifecycle: BaselineLifecycle = {}) {
    await ready;
    if (closing) throw new Error("The baseline service is closing.");
    if (!deps.runAttempt) throw new Error("No baseline model runner is configured.");
    const taskset = await requireTaskset(input.tasksetId);
    const models = input.models.slice(0, 4);
    if (!models.length) throw new Error("Baseline requires at least one model.");
    const seeds = input.seeds?.length ? input.seeds.slice(0, 8) : [17];
    const attemptsPerTask = Math.max(
      1,
      Math.min(MAX_BASELINE_ATTEMPTS_PER_TASK, input.attemptsPerTask ?? 4),
    );
    const split = input.split ?? "frozen_eval";
    if (split === "train" && (models.length !== 1 || seeds.length !== 1)) {
      throw new Error("A train-signal baseline requires exactly one model and one seed.");
    }
    const selectionStrategy = input.selectionStrategy ?? "stable_hash_top_n";
    const sampling = {
      maxOutputTokens: Math.max(
        1,
        Math.min(8_192, input.sampling?.maxOutputTokens ?? 2_048),
      ),
      temperature: Math.max(
        0,
        Math.min(2, input.sampling?.temperature ?? 0.8),
      ),
      topP: Math.max(0.000_001, Math.min(1, input.sampling?.topP ?? 0.95)),
    };
    const taskLimit = Math.max(
      1,
      Math.min(MAX_BASELINE_TASKS, input.taskLimit ?? 8),
    );
    await lifecycle.onStage?.("selecting");
    const selection = taskset.datasetArtifact
      ? await artifactBaselineTasks({
          taskset,
          split,
          limit: taskLimit,
          seed: input.selectionSeed ?? 17,
          selectionStrategy,
        })
      : inlineBaselineTasks({
          taskset,
          split,
          limit: taskLimit,
          seed: input.selectionSeed ?? 17,
          selectionStrategy,
        });
    const tasks = selection.tasks;
    const totalAttempts =
      tasks.length * models.length * seeds.length * attemptsPerTask;
    if (totalAttempts > MAX_BASELINE_TOTAL_ATTEMPTS) {
      throw new Error(
        `Baseline requests ${totalAttempts} attempts; the bounded limit is ${MAX_BASELINE_TOTAL_ATTEMPTS}.`,
      );
    }
    await lifecycle.onScope?.({
      scope: {
        split,
        taskCount: tasks.length,
        attemptsPerTask,
        selectionSeed: input.selectionSeed ?? 17,
        selectionStrategy,
        taskIdsHash: selection.taskIdsHash,
        model: models[0]!,
        sampling,
      },
      totalAttempts,
    });
    await lifecycle.onStage?.("auditing");
    const fixtureAudit = await auditFixtures({ tasksetId: taskset.id });
    await lifecycle.onStage?.("provisioning");
    const prepared = deps.prepareBaselineModels
      ? await deps.prepareBaselineModels(models, {
          signal: lifecycle.signal,
          onDeploymentUpdate: lifecycle.onDeploymentUpdate,
        })
      : { models, release: async () => ({ costUsd: null }) };
    let execution: Awaited<ReturnType<typeof runBaseline>>;
    let providerCostUsd: number | null = null;
    try {
      await lifecycle.onStage?.("running");
      execution = await runBaseline({
        taskset,
        tasks,
        models: prepared.models,
        seeds,
        attemptsPerTask,
        concurrency: 4,
        sampling,
        runAttempt: deps.runAttempt,
        gradeAttempt: gradeTasksetBaselineAttempt,
        modelJudge: deps.modelJudge ?? undefined,
        customVerifier: await customVerifierFor(taskset.id),
        signal: lifecycle.signal,
        onAttemptCompleted: lifecycle.onAttemptCompleted,
      });
    } finally {
      try {
        await lifecycle.onStage?.("cleaning_up");
      } finally {
        providerCostUsd = (await prepared.release()).costUsd;
        await lifecycle.onProviderCost?.(providerCostUsd);
      }
    }
    execution.report = BaselineReportSchema.parse({
      ...execution.report,
      totalCostUsd: providerCostUsd ?? execution.report.totalCostUsd,
      scope: {
        split,
        taskCount: tasks.length,
        attemptsPerTask,
        selectionSeed: input.selectionSeed ?? 17,
        selectionStrategy,
        taskIdsHash: selection.taskIdsHash,
        model: models[0]!,
        sampling,
      },
      rftSignal: split === "train"
        ? summarizeRftSignal(execution.attempts, execution.grades)
        : null,
    });
    await lifecycle.onStage?.("persisting");
    return persistBaselineExecution({ taskset, fixtureAudit: fixtureAudit.report, execution });
  }

  async function artifactBaselineTasks(input: {
    taskset: Awaited<ReturnType<typeof requireTaskset>>;
    split: "train" | "validation" | "frozen_eval";
    limit: number;
    seed: number;
    selectionStrategy: DatasetSelectionStrategy;
  }): Promise<{ tasks: TaskDataRecord[]; taskIdsHash: string }> {
    if (!deps.storeDir || !deps.projectDatasetArtifact) {
      throw new Error("Artifact-backed baseline projection is unavailable.");
    }
    const outputPath = path.join(
      deps.storeDir,
      "training",
      "baseline-selections",
      `${contentHash([
        input.taskset.contentHash,
        input.split,
        input.limit,
        input.seed,
        input.selectionStrategy,
      ])}.jsonl`,
    );
    try {
      const projection = await deps.projectDatasetArtifact({
        tasksetId: input.taskset.id,
        split: input.split,
        mode: "baseline",
        limit: input.limit,
        seed: input.seed,
        selectionStrategy: input.selectionStrategy,
        approvedSourceIds: [],
        outputPath,
      });
      const bytes = await readFile(outputPath);
      if (
        projection.mode !== "baseline"
        || projection.split !== input.split
        || projection.selectionStrategy !== input.selectionStrategy
        || projection.exampleCount > input.limit
        || projection.sizeBytes !== bytes.byteLength
        || projection.contentHash !== sha256(bytes)
      ) {
        throw new Error("Baseline Dataset selection failed integrity verification.");
      }
      const tasks = bytes.toString("utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => TaskDataRecordSchema.parse(JSON.parse(line)));
      if (tasks.length !== projection.exampleCount) {
        throw new Error("Baseline Dataset selection count does not match its receipt.");
      }
      return { tasks, taskIdsHash: projection.taskIdsHash };
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  async function regradeBaseline(input: { tasksetId: string; baselineReportId: string }) {
    const taskset = await requireTaskset(input.tasksetId);
    const reports = await deps.store.listBaselineReports(taskset.id);
    const sourceReport = reports.find((report) => report.id === input.baselineReportId);
    if (!sourceReport) throw new Error("Baseline report not found.");
    if (sourceReport.tasksetHash !== taskset.contentHash) {
      throw new Error("Baseline report does not match the current immutable Taskset revision.");
    }
    const attemptsById = new Map(
      (await deps.store.listTaskAttempts(taskset.id))
        .map((attempt) => [attempt.id, attempt]),
    );
    const attempts = sourceReport.attemptRefs.map((attemptId) => {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) throw new Error(`Baseline attempt ${attemptId} was not found.`);
      return attempt;
    });
    const customVerifier = await customVerifierFor(taskset.id);
    const grades = [];
    for (const attempt of attempts) {
      const task = await findTask(taskset, attempt.taskId, attempt.split);
      grades.push(await gradeTasksetBaselineAttempt({
        task,
        attempt,
        graders: taskset.graders,
        modelJudge: deps.modelJudge ?? undefined,
        customVerifier,
        now: () => new Date().toISOString(),
      }));
    }
    const attemptsPerTask = Math.max(
      1,
      ...Object.keys(sourceReport.passAtK)
        .map((key) => Number.parseInt(key, 10))
        .filter(Number.isFinite),
    );
    const fixtureAudit = await auditFixtures({ tasksetId: taskset.id });
    return persistBaselineExecution({
      taskset,
      fixtureAudit: fixtureAudit.report,
      execution: {
        attempts,
        grades,
        report: BaselineReportSchema.parse({
          ...buildBaselineReport({
            taskset,
            attempts,
            grades,
            attemptsPerTask,
          }),
          scope: sourceReport.scope,
          rftSignal: sourceReport.scope?.split === "train"
            ? summarizeRftSignal(attempts, grades)
            : null,
        }),
      },
    });
  }

  async function auditFixtures(input: { tasksetId: string; fixtures?: Array<{ label: "positive" | "negative" | "boundary" | "adversarial" | "prompt_injection" | "infrastructure_failure"; taskId: string; attempt: unknown; expectedPassed?: boolean; expectedRewardEligible?: boolean }> }) {
    const taskset = await requireTaskset(input.tasksetId);
    const customVerifier = await customVerifierFor(taskset.id);
    const results = [];
    const fixtures = input.fixtures?.length ? input.fixtures.map((fixture, index) => ({ ...fixture, id: `external_fixture_${index}` })) : taskset.graderFixtures.map((fixture, index) => ({
      id: fixture.id,
      label: fixture.label,
      taskId: fixture.taskId,
      expectedPassed: fixture.expectedPassed,
      expectedRewardEligible: fixture.expectedRewardEligible,
      attempt: fixtureAttempt(taskset.id, fixture, index),
    }));
    for (const fixture of fixtures) {
      const task = await findTask(
        taskset,
        fixture.taskId,
        artifactSplit(fixture),
      );
      const attempt = TaskAttemptResultSchema.parse(fixture.attempt);
      const result = await gradeAttempt({ task, attempt, graders: taskset.graders, modelJudge: deps.modelJudge ?? undefined, customVerifier });
      await deps.store.saveTaskAttempt(attempt);
      await deps.store.saveGradeResult(result);
      results.push({ id: fixture.id, label: fixture.label, expectedPassed: fixture.expectedPassed, expectedRewardEligible: fixture.expectedRewardEligible, result });
    }
    const failures = results.filter(({ label, expectedPassed, expectedRewardEligible, result }) => {
      if (label === "infrastructure_failure" && result.score !== null) return true;
      if (typeof expectedPassed === "boolean" && result.passed !== expectedPassed) return true;
      if (typeof expectedRewardEligible === "boolean" && result.rewardEligible !== expectedRewardEligible) return true;
      return false;
    });
    const infrastructureSafetyPassed = results.filter((item) => item.label === "infrastructure_failure").every((item) => item.result.score === null && item.result.rewardEligible === false);
    const hackingChecksPassed = !failures.some((item) => item.label === "adversarial" || item.label === "prompt_injection") && results.filter((item) => item.label === "adversarial" || item.label === "prompt_injection").every((item) => !item.result.passed && (item.result.score ?? 0) < 0.8);
    const leakageChecksPassed = results.every((item) => !item.result.feedback.some((feedback) => /privileged.*leak|hidden grader.*leak/i.test(feedback)));
    const reportFailures = failures.map((failure) => ({ fixtureId: failure.id, label: failure.label, gradeId: failure.result.id, reason: `Expected passed=${String(failure.expectedPassed)} and rewardEligible=${String(failure.expectedRewardEligible)}; received passed=${String(failure.result.passed)} and rewardEligible=${String(failure.result.rewardEligible)}.` }));
    const report = GraderAuditReportSchema.parse({ schemaVersion: "openpond.graderAuditReport.v1", id: `grader_audit_${contentHash([taskset.contentHash, results.map((item) => item.result.id)]).slice(0, 24)}`, tasksetId: taskset.id, tasksetHash: taskset.contentHash, fixtureRefs: results.map((item) => item.id), gradeRefs: results.map((item) => item.result.id), passed: reportFailures.length === 0 && infrastructureSafetyPassed && hackingChecksPassed && leakageChecksPassed, hackingChecksPassed, leakageChecksPassed, infrastructureSafetyPassed, failures: reportFailures, createdAt: new Date().toISOString() });
    await deps.store.saveGraderAuditReport(report);
    return { report, passed: report.passed, results, failures: reportFailures.map((failure) => ({ label: failure.label, gradeId: failure.gradeId })) };
  }

  async function calibrateModelJudges(tasksetId: string) {
    if (!deps.modelJudge) throw new Error("No model judge runner is configured.");
    const taskset = await requireTaskset(tasksetId);
    const judges = taskset.graders.filter((grader) => grader.kind === "model_judge");
    if (!judges.length) throw new Error("Taskset has no model judges to calibrate.");
    const calibrationResults = [];
    const graders = [];
    for (const grader of taskset.graders) {
      if (grader.kind !== "model_judge") { graders.push(grader); continue; }
      const fixtures = taskset.graderFixtures.filter((fixture) => grader.calibrationFixtureRefs.includes(fixture.id));
      const results = [];
      for (const [index, fixture] of fixtures.entries()) {
        const task = await findTask(
          taskset,
          fixture.taskId,
          artifactSplit(fixture),
        );
        const attempt = fixtureAttempt(taskset.id, fixture, index);
        try {
          const result = await deps.modelJudge({ grader, task, attempt });
          results.push({ fixtureId: fixture.id, expectedPassed: fixture.expectedPassed, passed: result.passed, score: result.score, feedback: result.feedback, matched: result.passed === fixture.expectedPassed });
        } catch (error) {
          results.push({ fixtureId: fixture.id, expectedPassed: fixture.expectedPassed, passed: false, score: 0, feedback: error instanceof Error ? error.message : String(error), matched: false });
        }
      }
      const passed = results.length > 0 && results.every((result) => result.matched);
      const evidenceHash = contentHash({ graderId: grader.id, graderVersion: grader.version, judge: grader.judge, rubric: grader.rubric, temperature: grader.temperature, results });
      graders.push({ ...grader, calibrationStatus: passed ? "passed" as const : "failed" as const, rewardEligible: passed && grader.metadata.requestedRewardEligible === true, metadata: { ...grader.metadata, calibrationEvidenceHash: evidenceHash, calibrationAccuracy: results.length ? results.filter((result) => result.matched).length / results.length : 0, calibratedAt: new Date().toISOString() } });
      calibrationResults.push({ graderId: grader.id, passed, evidenceHash, results });
    }
    const timestamp = new Date().toISOString();
    const unhashed = TasksetSchema.parse({
      ...taskset,
      revision: taskset.revision + 1,
      graders,
      status: "needs_review",
      readiness: null,
      contentHash: "00000000",
      updatedAt: timestamp,
      metadata: {
        ...taskset.metadata,
        judgeCalibration: {
          parentTasksetHash: taskset.contentHash,
          calibratedAt: timestamp,
          graderIds: calibrationResults.map((result) => result.graderId),
        },
      },
    });
    const updated = TasksetSchema.parse({ ...unhashed, contentHash: computeTasksetHash(unhashed) });
    if (!deps.storeDir) throw new Error("Managed Taskset storage is required for judge calibration.");
    await buildTaskset(updated, path.join(deps.storeDir, "training", "tasksets", updated.id));
    await deps.store.upsertTaskset(updated);
    return { taskset: updated, results: calibrationResults, passed: calibrationResults.every((result) => result.passed) };
  }

  async function readiness(tasksetId: string) {
    const taskset = await requireTaskset(tasksetId);
    const [baselineReports, auditReports] = await Promise.all([deps.store.listBaselineReports(tasksetId), deps.store.listGraderAuditReports(tasksetId)]);
    let graderAudit = auditReports.find((candidate) => candidate.tasksetHash === taskset.contentHash) ?? null;
    if (!graderAudit && !taskset.graders.some((grader) => grader.kind === "model_judge")) {
      graderAudit = (await auditFixtures({ tasksetId })).report;
    }
    const evaluationBaseline = baselineReports.find((candidate) =>
      candidate.tasksetHash === taskset.contentHash
      && candidate.scope?.split !== "train") ?? null;
    const report = buildTasksetReadiness({ taskset, baseline: evaluationBaseline, graderAudit });
    await deps.store.saveReadinessReport(report);
    await deps.store.upsertTaskset({
      ...taskset,
      status: report.ready ? "ready" : "needs_review",
      readiness: report,
      updatedAt: new Date().toISOString(),
    });
    return report;
  }

  async function requireTaskset(id: string) { const taskset = await deps.store.getTaskset(id); if (!taskset) throw new Error("Taskset not found."); return taskset; }
  async function findTask(
    taskset: Awaited<ReturnType<typeof requireTaskset>>,
    taskId: string,
    split?: DatasetSplit | null,
  ): Promise<TaskDataRecord> {
    const inline = taskset.tasks.find((task) => task.id === taskId);
    if (inline) return inline;
    if (!taskset.datasetArtifact || !deps.resolveTask) {
      throw new Error(`Task ${taskId} not found.`);
    }
    return deps.resolveTask({
      tasksetId: taskset.id,
      taskId,
      split,
    });
  }
  async function customVerifierFor(tasksetId: string) {
    const taskset = await requireTaskset(tasksetId);
    if (!taskset.graders.some((grader) => grader.kind === "custom_verifier")) {
      return undefined;
    }
    const profile = deps.storeDir
      ? null
      : await (deps.loadProfileState ?? loadOpenPondProfileState)();
    const tasksetRoot = deps.storeDir
      ? path.join(deps.storeDir, "training", "tasksets", tasksetId)
      : profile?.sourcePath
        ? path.join(profile.sourcePath, "tasksets", tasksetId)
        : null;
    const creationSnapshotId = typeof taskset.metadata.creationSnapshotId === "string"
      ? taskset.metadata.creationSnapshotId
      : null;
    const proposal = creationSnapshotId
      ? await deps.store.getTaskDesignProposal(creationSnapshotId)
      : null;
    if (tasksetRoot) {
      await buildTaskset(taskset, tasksetRoot, {
        generatedFiles: proposal?.generatedFiles ?? [],
      });
    }
    return tasksetRoot
      ? ({ grader, task, attempt }: Parameters<NonNullable<Parameters<typeof gradeAttempt>[0]["customVerifier"]>>[0]) => runSandboxedVerifier({ grader, task, attempt, allowedRoot: tasksetRoot })
      : undefined;
  }
  async function persistBaselineExecution(input: {
    taskset: Awaited<ReturnType<typeof requireTaskset>>;
    fixtureAudit: GraderAuditReport;
    execution: Awaited<ReturnType<typeof runBaseline>>;
  }) {
    const baselineFlags = auditFlags(input.execution.attempts, input.execution.grades);
    const auditedReport = BaselineReportSchema.parse({
      ...input.execution.report,
      hackingChecksPassed:
        baselineFlags.hackingChecksPassed
        && input.fixtureAudit.hackingChecksPassed
        && input.fixtureAudit.infrastructureSafetyPassed,
      leakageChecksPassed:
        baselineFlags.leakageChecksPassed
        && input.fixtureAudit.leakageChecksPassed,
    });
    for (const attempt of input.execution.attempts) await deps.store.saveTaskAttempt(attempt);
    for (const result of input.execution.grades) await deps.store.saveGradeResult(result);
    await deps.store.saveBaselineReport(auditedReport);
    const readinessBaseline = auditedReport.scope?.split === "train"
      ? (await deps.store.listBaselineReports(input.taskset.id)).find((report) =>
          report.id !== auditedReport.id
          && report.tasksetHash === input.taskset.contentHash
          && report.scope?.split !== "train") ?? null
      : auditedReport;
    const readiness = buildTasksetReadiness({
      taskset: input.taskset,
      baseline: readinessBaseline,
      graderAudit: input.fixtureAudit,
    });
    await deps.store.saveReadinessReport(readiness);
    await deps.store.upsertTaskset({
      ...input.taskset,
      status: readiness.ready ? "ready" : "needs_review",
      readiness,
      updatedAt: new Date().toISOString(),
    });
    return {
      report: auditedReport,
      readiness,
      attempts: input.execution.attempts,
      grades: input.execution.grades,
    };
  }

  async function startBaseline(input: Parameters<typeof baseline>[0]): Promise<TasksetBaselineRun> {
    await ready;
    if (closing) throw new Error("The baseline service is closing.");
    const taskset = await requireTaskset(input.tasksetId);
    const models = input.models.slice(0, 4);
    const seeds = input.seeds?.length ? input.seeds.slice(0, 8) : [17];
    if (models.length !== 1 || seeds.length !== 1) {
      throw new Error("A persisted baseline run requires exactly one model and one seed.");
    }
    const attemptsPerTask = Math.max(
      1,
      Math.min(MAX_BASELINE_ATTEMPTS_PER_TASK, input.attemptsPerTask ?? 4),
    );
    const taskLimit = Math.max(
      1,
      Math.min(MAX_BASELINE_TASKS, input.taskLimit ?? 8),
    );
    const split = input.split ?? "frozen_eval";
    const selectionStrategy = input.selectionStrategy ?? "stable_hash_top_n";
    const sampling = {
      maxOutputTokens: Math.max(
        1,
        Math.min(8_192, input.sampling?.maxOutputTokens ?? 2_048),
      ),
      temperature: Math.max(
        0,
        Math.min(2, input.sampling?.temperature ?? 0.8),
      ),
      topP: Math.max(0.000_001, Math.min(1, input.sampling?.topP ?? 0.95)),
    };
    const totalAttempts = taskLimit * attemptsPerTask;
    if (totalAttempts > MAX_BASELINE_TOTAL_ATTEMPTS) {
      throw new Error(
        `Baseline requests ${totalAttempts} attempts; the bounded limit is ${MAX_BASELINE_TOTAL_ATTEMPTS}.`,
      );
    }
    const timestamp = new Date().toISOString();
    const run = TasksetBaselineRunSchema.parse({
      schemaVersion: "openpond.tasksetBaselineRun.v1",
      id: `baseline_run_${randomUUID()}`,
      profileId: taskset.profileId,
      targetModelId: input.targetModelId ?? null,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      status: "queued",
      configuration: {
        split,
        taskLimit,
        attemptsPerTask,
        selectionSeed: input.selectionSeed ?? 17,
        selectionStrategy,
        model: models[0]!,
        sampling,
      },
      scope: null,
      progress: {
        stage: "queued",
        completedAttempts: 0,
        totalAttempts,
        correctAttempts: 0,
        incorrectAttempts: 0,
        parseableAttempts: 0,
        infrastructureFailures: 0,
      },
      provider: null,
      reportId: null,
      estimatedCostUsd: null,
      cancelRequested: false,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    });
    await baselineStartAdmission.run(
      `${taskset.id}:${taskset.contentHash}`,
      async () => {
        const existing = (await deps.store.listTasksetBaselineRuns({
          tasksetId: taskset.id,
        })).find((candidate) =>
          candidate.tasksetHash === taskset.contentHash
          && isActiveBaselineRun(candidate.status));
        if (existing) {
          throw new Error(
            `Baseline run ${existing.id} is already ${existing.status}.`,
          );
        }
        await deps.store.saveTasksetBaselineRun(run);
      },
    );

    const controller = new AbortController();
    const normalizedInput: Parameters<typeof baseline>[0] = {
      ...input,
      models,
      seeds,
      attemptsPerTask,
      taskLimit,
      split,
      selectionStrategy,
      sampling,
    };
    const execution = Promise.resolve()
      .then(() => executeBaselineRun(run, normalizedInput, controller))
      .catch(async (error) => {
        const persisted = await deps.store.getTasksetBaselineRun(run.id).catch(() => null);
        if (!persisted || !isActiveBaselineRun(persisted.status)) return;
        const completedAt = new Date().toISOString();
        await deps.store.saveTasksetBaselineRun({
          ...persisted,
          status: controller.signal.aborted ? "cancelled" : "failed",
          cancelRequested: controller.signal.aborted || persisted.cancelRequested,
          error: controller.signal.aborted ? null : errorMessage(error),
          completedAt,
          updatedAt: completedAt,
        });
      })
      .finally(() => activeBaselineRuns.delete(run.id));
    activeBaselineRuns.set(run.id, { controller, execution });
    return run;
  }

  async function executeBaselineRun(
    initial: TasksetBaselineRun,
    input: Parameters<typeof baseline>[0],
    controller: AbortController,
  ): Promise<void> {
    let writeQueue = Promise.resolve();
    const enqueue = (
      mutation: (run: TasksetBaselineRun) => TasksetBaselineRun,
    ): Promise<void> => {
      const write = writeQueue.then(async () => {
        const current = await deps.store.getTasksetBaselineRun(initial.id);
        if (!current) {
          throw new Error("The baseline run disappeared while it was executing.");
        }
        if (current.cancelRequested && !controller.signal.aborted) {
          controller.abort(abortError("The baseline run was cancelled."));
        }
        await deps.store.saveTasksetBaselineRun(mutation(current));
      });
      writeQueue = write.catch(() => {});
      return write;
    };
    const stage = (next: TasksetBaselineRun["progress"]["stage"]) =>
      enqueue((current) => {
        const timestamp = new Date().toISOString();
        return {
          ...current,
          status: next === "running" || next === "persisting" || next === "cleaning_up"
            ? "running"
            : current.status === "queued" ? "preparing" : current.status,
          progress: { ...current.progress, stage: next },
          startedAt: current.startedAt ?? timestamp,
          updatedAt: timestamp,
        };
      });

    try {
      const result = await baseline(input, {
        signal: controller.signal,
        onStage: stage,
        onScope: ({ scope, totalAttempts }) => enqueue((current) => ({
          ...current,
          scope,
          progress: { ...current.progress, totalAttempts },
          updatedAt: new Date().toISOString(),
        })),
        onDeploymentUpdate: (update) => enqueue((current) => {
          const timestamp = new Date().toISOString();
          const existing = current.provider?.deploymentId === update.deploymentId
            ? current.provider
            : null;
          return {
            ...current,
            provider: {
              providerId: "fireworks",
              accountId: update.accountId,
              deploymentId: update.deploymentId,
              phase: update.phase,
              state: update.state ?? existing?.state ?? null,
              statusCode: update.statusCode ?? existing?.statusCode ?? null,
              statusMessage: update.statusMessage ?? existing?.statusMessage ?? null,
              createdAt: existing?.createdAt ?? timestamp,
              readyAt: update.phase === "ready"
                ? existing?.readyAt ?? timestamp
                : existing?.readyAt ?? null,
              releasedAt: update.phase === "deleted"
                ? timestamp
                : existing?.releasedAt ?? null,
            },
            updatedAt: timestamp,
          };
        }),
        onAttemptCompleted: ({ completedAttempts, totalAttempts, attempt, grade }) =>
          enqueue((current) => {
            const eligible = grade.score !== null;
            const text = typeof attempt.output.text === "string"
              ? attempt.output.text
              : "";
            return {
              ...current,
              progress: {
                ...current.progress,
                completedAttempts: Math.max(
                  current.progress.completedAttempts,
                  completedAttempts,
                ),
                totalAttempts,
                correctAttempts: current.progress.correctAttempts
                  + (eligible && grade.passed ? 1 : 0),
                incorrectAttempts: current.progress.incorrectAttempts
                  + (eligible && !grade.passed ? 1 : 0),
                parseableAttempts: current.progress.parseableAttempts
                  + (extractFinalAnswer(text) !== null ? 1 : 0),
                infrastructureFailures: current.progress.infrastructureFailures
                  + (attempt.infrastructureError || grade.failureClass === "infrastructure_failure" ? 1 : 0),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        onProviderCost: (costUsd) => enqueue((current) => ({
          ...current,
          estimatedCostUsd: costUsd,
          updatedAt: new Date().toISOString(),
        })),
      });
      await writeQueue;
      const persisted = await deps.store.getTasksetBaselineRun(initial.id);
      if (!persisted) throw new Error("The baseline run disappeared before completion.");
      const completedAt = new Date().toISOString();
      await deps.store.saveTasksetBaselineRun({
        ...persisted,
        status: "succeeded",
        progress: { ...persisted.progress, stage: "complete" },
        reportId: result.report.id,
        estimatedCostUsd: result.report.totalCostUsd,
        error: null,
        completedAt,
        updatedAt: completedAt,
      });
    } catch (error) {
      await writeQueue;
      const persisted = await deps.store.getTasksetBaselineRun(initial.id) ?? initial;
      const cancelled = controller.signal.aborted || persisted.cancelRequested;
      const completedAt = new Date().toISOString();
      await deps.store.saveTasksetBaselineRun({
        ...persisted,
        status: cancelled ? "cancelled" : "failed",
        cancelRequested: cancelled || persisted.cancelRequested,
        error: cancelled ? null : errorMessage(error),
        completedAt,
        updatedAt: completedAt,
      });
    }
  }

  async function cancelBaselineRun(id: string): Promise<TasksetBaselineRun> {
    await ready;
    const run = await deps.store.getTasksetBaselineRun(id);
    if (!run) throw new Error("Baseline run not found.");
    if (!isActiveBaselineRun(run.status)) return run;
    const updated = await deps.store.saveTasksetBaselineRun({
      ...run,
      status: "cancelling",
      cancelRequested: true,
      updatedAt: new Date().toISOString(),
    });
    activeBaselineRuns.get(id)?.controller.abort(
      abortError("The baseline run was cancelled."),
    );
    return updated;
  }

  async function close(): Promise<void> {
    closing = true;
    await ready;
    for (const active of activeBaselineRuns.values()) {
      active.controller.abort(
        abortError("The baseline run stopped because the server is closing."),
      );
    }
    await Promise.allSettled(
      [...activeBaselineRuns.values()].map((active) => active.execution),
    );
  }

  async function reconcileInterruptedBaselineRuns(): Promise<void> {
    const runs = await deps.store.listTasksetBaselineRuns();
    let cleanupError: string | null = null;
    try {
      await deps.cleanupBaselineDeployments?.();
    } catch (error) {
      cleanupError = errorMessage(error);
    }
    for (const run of runs) {
      if (!isActiveBaselineRun(run.status)) continue;
      const completedAt = new Date().toISOString();
      await deps.store.saveTasksetBaselineRun({
        ...run,
        status: "failed",
        error: cleanupError
          ? `The server restarted before this baseline completed, and provider cleanup could not be confirmed: ${cleanupError}`
          : "The server restarted before this baseline completed. Any temporary Fireworks deployment was cleaned up.",
        completedAt,
        updatedAt: completedAt,
      });
    }
  }

  return {
    grade,
    baseline,
    startBaseline,
    cancelBaselineRun,
    regradeBaseline,
    auditFixtures,
    calibrateModelJudges,
    readiness,
    close,
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
