import path from "node:path";
import { aggregateEvaluationReceipts } from "@openpond/evals";
import {
  GraderAuditReportSchema,
  TasksetSchema,
  TaskAttemptResultSchema,
  type ChatModelRef,
  type DatasetSplit,
  type TaskDataRecord,
} from "@openpond/contracts";
import {
  buildTaskset,
  computeTasksetHash,
  contentHash,
  gradeAttempt,
  type ModelJudgeRunner,
} from "@openpond/taskset-sdk";
import { loadOpenPondProfileState } from "@openpond/cloud";

import type { SqliteStore } from "../store/store.js";
import { artifactSplit, fixtureAttempt } from "./evaluation-helpers.js";
import { buildTasksetReadiness } from "./readiness.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";
import { gradeTasksetEvaluationAttempt } from "./task-evaluation-grade-runner.js";
import { runPostTrainingEvaluationAttempt } from "./task-evaluation-attempt-runner.js";
import {
  compileDesktopHarnessContext,
  projectDesktopAttemptReceipt,
} from "./portable-evals-adapter.js";
import type {
  TasksetWorkAttemptRuntime,
  TasksetWorkModelStream,
  TasksetWorkRequiredOutputValidator,
} from "./taskset-work-attempt-runner.js";
import { linkHarnessReviewTaskset } from "./harness-review-taskset.js";

type AuditFixtureInput = {
  label:
    | "positive"
    | "negative"
    | "boundary"
    | "adversarial"
    | "prompt_injection"
    | "infrastructure_failure";
  taskId: string;
  attempt: unknown;
  expectedPassed?: boolean;
  expectedRewardEligible?: boolean;
};

export function createTaskEvaluationService(deps: {
  store: SqliteStore;
  storeDir?: string;
  modelJudge?: ModelJudgeRunner | null;
  loadProfileState?: typeof loadOpenPondProfileState;
  resolveTask?: (input: {
    tasksetId: string;
    taskId: string;
    split?: DatasetSplit | null;
  }) => Promise<TaskDataRecord>;
  modelText?: Parameters<
    typeof runPostTrainingEvaluationAttempt
  >[0]["modelText"];
  modelStream?: TasksetWorkModelStream;
  workRuntime?: TasksetWorkAttemptRuntime;
  validateWorkRequiredOutput?: TasksetWorkRequiredOutputValidator;
  resolveReleasedHarness?: () => Promise<{
    agentSnapshot: import("@openpond/harness").AgentSnapshot;
    harnessRelease: import("@openpond/harness").HarnessRelease;
  } | null>;
}) {
  async function execute(input: {
    tasksetId: string;
    taskId: string;
    model: ChatModelRef;
    seed: number;
    attempt: number;
    sampling?: {
      maxOutputTokens: number;
      temperature: number;
      topP: number;
    };
    signal?: AbortSignal;
    resultId?: string;
    admittedAt?: string;
  }) {
    if (
      !deps.storeDir
      || !deps.modelText
      || !deps.modelStream
      || !deps.workRuntime
    ) {
      throw new Error("Taskset execution is not configured.");
    }
    const taskset = await requireTaskset(input.tasksetId);
    const task = await findTask(taskset, input.taskId);
    // Resolve the complete portable graph before the first model or tool step.
    // Profile source may change while an Evaluation is running, but the
    // attempt, grade, and receipt must remain bound to the release selected at
    // admission time.
    const releasedHarness = await deps.resolveReleasedHarness?.() ?? null;
    const profile = !releasedHarness && deps.loadProfileState ? await deps.loadProfileState() : null;
    const portable = compileDesktopHarnessContext({
      taskset,
      selectedTask: task,
      profile,
      releasedHarness,
      model: input.model,
      now: input.admittedAt ? () => input.admittedAt! : undefined,
    });
    const attempt = await runPostTrainingEvaluationAttempt({
      store: deps.store,
      storeDir: deps.storeDir,
      modelText: deps.modelText,
      crossSystemStream: deps.modelStream,
      work: {
        stream: deps.modelStream,
        runtime: deps.workRuntime,
        validateRequiredOutput: deps.validateWorkRequiredOutput,
      },
      resultId: input.resultId,
      attemptInput: {
        tasksetId: taskset.id,
        task,
        model: input.model,
        seed: input.seed,
        attempt: input.attempt,
        sampling: input.sampling,
        signal: input.signal,
      },
    });
    const gradeResult = await grade({
      tasksetId: taskset.id,
      taskId: task.id,
      attempt,
    });
    const artifacts = await deps.store.listTaskAttemptArtifacts({
      attemptId: attempt.id,
    });
    const receipt = projectDesktopAttemptReceipt({
      manifest: portable.runManifest,
      attempt,
      grade: gradeResult,
      artifacts,
    });
    const persistedAttempt = TaskAttemptResultSchema.parse({
      ...attempt,
      metadata: {
        ...attempt.metadata,
        portableRunManifestRef: {
          id: portable.runManifest.id,
          contentHash: portable.runManifest.contentHash,
        },
        portableAttemptReceipt: receipt,
      },
    });
    await deps.store.saveTaskAttempt(persistedAttempt);
    const evaluationResult = aggregateEvaluationReceipts({
      id: `evaluation-${receipt.id}`,
      manifest: portable.runManifest,
      receipts: [receipt],
      metadata: {
        sourceTasksetId: taskset.id,
        sourceAttemptId: attempt.id,
        sourceGradeId: gradeResult.id,
      },
    });
    return {
      attempt: persistedAttempt,
      grade: gradeResult,
      artifacts,
      portable: {
        agentSnapshot: portable.agentSnapshot,
        harnessRelease: portable.harnessRelease,
        tasksetRelease: portable.tasksetRelease,
        runManifest: portable.runManifest,
        receipt,
        evaluationResult,
      },
    };
  }

  async function grade(input: {
    tasksetId: string;
    taskId: string;
    attempt: unknown;
  }) {
    const taskset = await requireTaskset(input.tasksetId);
    const attempt = TaskAttemptResultSchema.parse(input.attempt);
    const task = await findTask(taskset, input.taskId, attempt.split);
    const customVerifier = await customVerifierFor(taskset.id);
    const result = await gradeTasksetEvaluationAttempt({
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

  async function auditFixtures(input: {
    tasksetId: string;
    fixtures?: AuditFixtureInput[];
  }) {
    const taskset = await requireTaskset(input.tasksetId);
    const customVerifier = await customVerifierFor(taskset.id);
    const fixtures = input.fixtures?.length
      ? input.fixtures.map((fixture, index) => ({
          ...fixture,
          id: `external_fixture_${index}`,
        }))
      : taskset.graderFixtures.map((fixture, index) => ({
          id: fixture.id,
          label: fixture.label,
          taskId: fixture.taskId,
          expectedPassed: fixture.expectedPassed,
          expectedRewardEligible: fixture.expectedRewardEligible,
          attempt: fixtureAttempt(taskset.id, fixture, index),
        }));
    const results = [];

    for (const fixture of fixtures) {
      const task = await findTask(
        taskset,
        fixture.taskId,
        artifactSplit(fixture),
      );
      const attempt = TaskAttemptResultSchema.parse(fixture.attempt);
      const result = await gradeAttempt({
        task,
        attempt,
        graders: taskset.graders,
        modelJudge: deps.modelJudge ?? undefined,
        customVerifier,
      });
      await deps.store.saveTaskAttempt(attempt);
      await deps.store.saveGradeResult(result);
      results.push({
        id: fixture.id,
        label: fixture.label,
        expectedPassed: fixture.expectedPassed,
        expectedRewardEligible: fixture.expectedRewardEligible,
        result,
      });
    }

    const failures = results.filter(
      ({ label, expectedPassed, expectedRewardEligible, result }) => {
        if (label === "infrastructure_failure" && result.score !== null) {
          return true;
        }
        if (
          typeof expectedPassed === "boolean"
          && result.passed !== expectedPassed
        ) {
          return true;
        }
        return (
          typeof expectedRewardEligible === "boolean"
          && result.rewardEligible !== expectedRewardEligible
        );
      },
    );
    const infrastructureSafetyPassed = results
      .filter((item) => item.label === "infrastructure_failure")
      .every(
        (item) =>
          item.result.score === null && item.result.rewardEligible === false,
      );
    const hackingChecksPassed =
      !failures.some(
        (item) =>
          item.label === "adversarial"
          || item.label === "prompt_injection",
      )
      && results
        .filter(
          (item) =>
            item.label === "adversarial"
            || item.label === "prompt_injection",
        )
        .every(
          (item) =>
            !item.result.passed && (item.result.score ?? 0) < 0.8,
        );
    const leakageChecksPassed = results.every(
      (item) =>
        !item.result.feedback.some((feedback) =>
          /privileged.*leak|hidden grader.*leak/i.test(feedback),
        ),
    );
    const reportFailures = failures.map((failure) => ({
      fixtureId: failure.id,
      label: failure.label,
      gradeId: failure.result.id,
      reason:
        `Expected passed=${String(failure.expectedPassed)} and `
        + `rewardEligible=${String(failure.expectedRewardEligible)}; received `
        + `passed=${String(failure.result.passed)} and `
        + `rewardEligible=${String(failure.result.rewardEligible)}.`,
    }));
    const report = GraderAuditReportSchema.parse({
      schemaVersion: "openpond.graderAuditReport.v1",
      id: `grader_audit_${contentHash([
        taskset.contentHash,
        results.map((item) => item.result.id),
      ]).slice(0, 24)}`,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      fixtureRefs: results.map((item) => item.id),
      gradeRefs: results.map((item) => item.result.id),
      passed:
        reportFailures.length === 0
        && infrastructureSafetyPassed
        && hackingChecksPassed
        && leakageChecksPassed,
      hackingChecksPassed,
      leakageChecksPassed,
      infrastructureSafetyPassed,
      failures: reportFailures,
      createdAt: new Date().toISOString(),
    });
    await deps.store.saveGraderAuditReport(report);
    return {
      report,
      passed: report.passed,
      results,
      failures: reportFailures.map((failure) => ({
        label: failure.label,
        gradeId: failure.gradeId,
      })),
    };
  }

  async function calibrateModelJudges(tasksetId: string) {
    if (!deps.modelJudge) {
      throw new Error("No model judge runner is configured.");
    }
    const taskset = await requireTaskset(tasksetId);
    const judges = taskset.graders.filter(
      (grader) => grader.kind === "model_judge",
    );
    if (!judges.length) throw new Error("Taskset has no model judges to calibrate.");
    const calibrationResults = [];
    const graders = [];

    for (const grader of taskset.graders) {
      if (grader.kind !== "model_judge") {
        graders.push(grader);
        continue;
      }
      const fixtures = taskset.graderFixtures.filter((fixture) =>
        grader.calibrationFixtureRefs.includes(fixture.id),
      );
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
          results.push({
            fixtureId: fixture.id,
            expectedPassed: fixture.expectedPassed,
            passed: result.passed,
            score: result.score,
            feedback: result.feedback,
            matched: result.passed === fixture.expectedPassed,
          });
        } catch (error) {
          results.push({
            fixtureId: fixture.id,
            expectedPassed: fixture.expectedPassed,
            passed: false,
            score: 0,
            feedback: error instanceof Error ? error.message : String(error),
            matched: false,
          });
        }
      }
      const passed =
        results.length > 0 && results.every((result) => result.matched);
      const evidenceHash = contentHash({
        graderId: grader.id,
        graderVersion: grader.version,
        judge: grader.judge,
        rubric: grader.rubric,
        temperature: grader.temperature,
        results,
      });
      graders.push({
        ...grader,
        calibrationStatus: passed ? "passed" as const : "failed" as const,
        rewardEligible:
          passed && grader.metadata.requestedRewardEligible === true,
        metadata: {
          ...grader.metadata,
          calibrationEvidenceHash: evidenceHash,
          calibrationAccuracy: results.length
            ? results.filter((result) => result.matched).length / results.length
            : 0,
          calibratedAt: new Date().toISOString(),
        },
      });
      calibrationResults.push({
        graderId: grader.id,
        passed,
        evidenceHash,
        results,
      });
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
    const updated = TasksetSchema.parse({
      ...unhashed,
      contentHash: computeTasksetHash(unhashed),
    });
    if (!deps.storeDir) {
      throw new Error("Managed Taskset storage is required for judge calibration.");
    }
    await buildTaskset(
      updated,
      path.join(deps.storeDir, "training", "tasksets", updated.id),
    );
    await deps.store.upsertTaskset(updated);
    return {
      taskset: updated,
      results: calibrationResults,
      passed: calibrationResults.every((result) => result.passed),
    };
  }

  async function readiness(tasksetId: string) {
    const taskset = await requireTaskset(tasksetId);
    const auditReports =
      await deps.store.listGraderAuditReports(tasksetId);
    let graderAudit =
      auditReports.find(
        (candidate) => candidate.tasksetHash === taskset.contentHash,
      ) ?? null;
    if (
      !graderAudit
      && !taskset.graders.some((grader) => grader.kind === "model_judge")
    ) {
      graderAudit = (await auditFixtures({ tasksetId })).report;
    }
    const report = buildTasksetReadiness({ taskset, graderAudit });
    await deps.store.saveReadinessReport(report);
    await deps.store.upsertTaskset({
      ...taskset,
      status: report.ready ? "ready" : "needs_review",
      readiness: report,
      updatedAt: new Date().toISOString(),
    });
    return report;
  }

  async function executeBaseline(input: {
    tasksetId: string;
    model: ChatModelRef;
    reviewRef: { id: string; contentHash: string };
    seeds?: number[];
    attemptsPerTask?: number;
    sampling?: {
      maxOutputTokens: number;
      temperature: number;
      topP: number;
    };
    signal?: AbortSignal;
  }) {
    const taskset = await requireTaskset(input.tasksetId);
    if (taskset.status !== "ready" || taskset.readiness?.ready !== true) {
      throw new Error("Taskset must pass grader audit and readiness before baseline Evaluation.");
    }
    const lineage = taskset.metadata.harnessEvaluationReview;
    if (
      !lineage ||
      typeof lineage !== "object" ||
      Array.isArray(lineage) ||
      (lineage as { id?: unknown }).id !== input.reviewRef.id ||
      (lineage as { contentHash?: unknown }).contentHash !== input.reviewRef.contentHash
    ) {
      throw new Error("Taskset does not bind the supplied Harness Evaluation review.");
    }
    const existing = (await deps.store.listEvaluationResults(taskset.id, "baseline"))
      .find((result) =>
        result.metadata.sourceTasksetHash === taskset.contentHash &&
        result.model.provider === input.model.providerId &&
        result.model.model === input.model.modelId &&
        reviewRefMatches(result.metadata.harnessEvaluationReview, input.reviewRef),
      );
    if (existing) return { evaluationResult: existing, attempts: [], reused: true };

    const tasks = taskset.tasks.filter((task) => task.split === "frozen_eval");
    if (!tasks.length) {
      throw new Error("Baseline Evaluation requires at least one isolated frozen-evaluation task.");
    }
    const seeds = [...new Set(input.seeds?.length ? input.seeds : [17])].slice(0, 100);
    const attemptsPerTask = Math.max(1, Math.min(20, Math.trunc(input.attemptsPerTask ?? 1)));
    const admittedAt = new Date().toISOString();
    const executions: Awaited<ReturnType<typeof execute>>[] = [];
    for (const task of tasks) {
      for (const seed of seeds) {
        for (let attempt = 0; attempt < attemptsPerTask; attempt += 1) {
          if (input.signal?.aborted) throw input.signal.reason;
          executions.push(await execute({
            tasksetId: taskset.id,
            taskId: task.id,
            model: input.model,
            seed,
            attempt,
            sampling: input.sampling,
            signal: input.signal,
            admittedAt,
            resultId: `baseline-attempt-${contentHash({
              reviewRef: input.reviewRef,
              tasksetHash: taskset.contentHash,
              model: input.model,
              taskId: task.id,
              seed,
              attempt,
            }).slice(0, 24)}`,
          }));
        }
      }
    }
    const manifest = executions[0]!.portable.runManifest;
    if (executions.some((execution) => execution.portable.runManifest.contentHash !== manifest.contentHash)) {
      throw new Error("Baseline attempts did not share one frozen Run Manifest.");
    }
    const receipts = executions.map((execution) => execution.portable.receipt);
    const evaluationResult = aggregateEvaluationReceipts({
      id: `baseline-evaluation-${contentHash({
        manifest: manifest.contentHash,
        receipts: receipts.map((receipt) => receipt.contentHash),
        reviewRef: input.reviewRef,
      }).slice(0, 24)}`,
      manifest,
      receipts,
      metadata: {
        kind: "baseline",
        sourceTasksetId: taskset.id,
        sourceTasksetRevision: taskset.revision,
        sourceTasksetHash: taskset.contentHash,
        harnessEvaluationReview: input.reviewRef,
        admittedAt,
      },
    });
    await deps.store.saveEvaluationResult({
      tasksetId: taskset.id,
      kind: "baseline",
      result: evaluationResult,
      createdAt: admittedAt,
    });
    await linkHarnessReviewTaskset({
      store: deps.store,
      taskset,
      evaluationResult,
    });
    return { evaluationResult, attempts: executions, reused: false };
  }

  async function requireTaskset(id: string) {
    const taskset = await deps.store.getTaskset(id);
    if (!taskset) throw new Error("Taskset not found.");
    return taskset;
  }

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
    return deps.resolveTask({ tasksetId: taskset.id, taskId, split });
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
    const creationSnapshotId =
      typeof taskset.metadata.creationSnapshotId === "string"
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
      ? ({
          grader,
          task,
          attempt,
        }: Parameters<
          NonNullable<
            Parameters<typeof gradeAttempt>[0]["customVerifier"]
          >
        >[0]) =>
          runSandboxedVerifier({
            grader,
            task,
            attempt,
            allowedRoot: tasksetRoot,
          })
      : undefined;
  }

  return {
    execute,
    grade,
    auditFixtures,
    calibrateModelJudges,
    readiness,
    executeBaseline,
    close: async () => {},
  };
}

function reviewRefMatches(
  value: unknown,
  expected: { id: string; contentHash: string },
): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { id?: unknown }).id === expected.id &&
    (value as { contentHash?: unknown }).contentHash === expected.contentHash,
  );
}
