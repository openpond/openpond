import path from "node:path";
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
import type {
  TasksetWorkAttemptRuntime,
  TasksetWorkModelStream,
  TasksetWorkRequiredOutputValidator,
} from "./taskset-work-attempt-runner.js";

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
    return {
      attempt,
      grade: gradeResult,
      artifacts: await deps.store.listTaskAttemptArtifacts({
        attemptId: attempt.id,
      }),
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
    close: async () => {},
  };
}
