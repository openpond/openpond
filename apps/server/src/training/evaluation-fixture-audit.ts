import { z } from "zod";
import { GraderAuditReportSchema, TaskAttemptResultSchema, type Taskset, type TaskDataRecord, type DatasetSplit } from "@openpond/contracts";
import { contentHash, gradeAttempt, gradeCalibrationAttempt, type ModelJudgeRunner } from "@openpond/taskset-sdk";
import { requireLocalTasksetRevision, type LocalTasksetRevisionRef } from "./local-taskset-release.js";
import { artifactSplit, fixtureAttempt } from "./evaluation-helpers.js";
import { createTasksetEvaluationVerifier } from "./evaluation-custom-verifier.js";
import { captureTasksetEvaluationPackage } from "./taskset-process-verifier.js";
import { localGraderFixtureArtifacts } from "./local-grader-fixture-artifacts.js";
import { STARTER_TOOL_ENVIRONMENT } from "./starter-tool-environment.js";
import { runStarterToolFixture } from "./starter-tool-fixture.js";
import { resolveTasksetRewardBinding } from "./taskset-reward-binding.js";
import { fixtureScoreMatches, parseExpectedFixtureScore } from "./fixture-score-expectation.js";

export type AuditFixtureInput = {
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
  expectedScore?: number | null;
};

export type AuditTasksetFixturesInput = { tasksetId: string; tasksetRef?: LocalTasksetRevisionRef; fixtures?: AuditFixtureInput[] };
type FixtureAuditDeps = Parameters<typeof createTasksetEvaluationVerifier>[0] & {
  modelJudge?: ModelJudgeRunner | null;
  findTask(taskset: Taskset, taskId: string, split?: DatasetSplit | null): Promise<TaskDataRecord>;
};

export async function auditTasksetFixtures(deps: FixtureAuditDeps, input: AuditTasksetFixturesInput) {
    const taskset = await requireLocalTasksetRevision(deps.store, input.tasksetId, input.tasksetRef);
    const needsPrivatePackage = taskset.graders.some(grader => grader.kind === "custom_verifier" && grader.runtime === "sandbox_process")
      || (!input.fixtures?.length && taskset.graderFixtures.some(fixture => fixture.metadata.artifactAssetIds !== undefined));
    if (needsPrivatePackage && !deps.storeDir) throw new Error("Private fixture grading requires the execution owner's package directory.");
    const packageValue = needsPrivatePackage ? await captureTasksetEvaluationPackage(deps.storeDir!, taskset) : undefined;
    const fixtureEvidence = new Map<string, { attemptHash: string; artifacts: ReturnType<typeof localGraderFixtureArtifacts> }>();
    const customVerifier = await createTasksetEvaluationVerifier(deps, taskset, packageValue ? { packageValue, fixtures: fixtureEvidence } : undefined);
    const fixtures = input.fixtures?.length
      ? input.fixtures.map((fixture, index) => ({
          ...fixture,
          expectedScore: parseExpectedFixtureScore(fixture.expectedScore),
          id: `external_fixture_${index}`,
        }))
      : taskset.graderFixtures.map((fixture, index) => ({
          id: fixture.id,
          label: fixture.label,
          taskId: fixture.taskId,
          expectedPassed: fixture.expectedPassed,
          expectedRewardEligible: fixture.expectedRewardEligible,
          expectedScore: parseExpectedFixtureScore(fixture.metadata.expectedScore),
          attempt: fixtureAttempt(taskset.id, fixture, index),
        }));
    const results = [];

    for (const fixture of fixtures) {
      const task = await deps.findTask(
        taskset,
        fixture.taskId,
        artifactSplit(fixture),
      );
      const authored = input.fixtures?.length ? undefined : taskset.graderFixtures.find(candidate => candidate.id === fixture.id);
      if (taskset.environment.entrypoint === STARTER_TOOL_ENVIRONMENT && authored && !authored.infrastructureError && !deps.storeDir) throw new Error("Tool fixture execution requires the owner's artifact directory.");
      let attempt = taskset.environment.entrypoint === STARTER_TOOL_ENVIRONMENT && authored && !authored.infrastructureError
        ? await runStarterToolFixture({ store: deps.store, storeDir: deps.storeDir!, taskset, task, fixture: authored })
        : TaskAttemptResultSchema.parse(fixture.attempt);
      if (authored) attempt = TaskAttemptResultSchema.parse({ ...attempt, split: task.split });
      if (authored && packageValue) {
        const artifacts = localGraderFixtureArtifacts(packageValue, authored);
        attempt = TaskAttemptResultSchema.parse({ ...attempt, artifactRefs: artifacts.map(artifact => artifact.reference.id) });
        fixtureEvidence.set(attempt.id, { attemptHash: contentHash(attempt), artifacts });
      }
      const graderIds = authored?.metadata.graderIds === undefined ? undefined
        : z.array(z.string().min(1)).min(1).parse(authored.metadata.graderIds);
      if (graderIds && (new Set(graderIds).size !== graderIds.length || graderIds.some(id => !taskset.graders.some(grader => grader.id === id)))) {
        throw new Error("Fixture grader scope must contain unique declared grader IDs.");
      }
      const result = await (graderIds ? gradeCalibrationAttempt : gradeAttempt)({
        task,
        attempt,
        graders: graderIds ? taskset.graders.filter(grader => graderIds.includes(grader.id)) : taskset.graders,
        learning: await resolveTasksetRewardBinding(deps.store, taskset),
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
        expectedScore: fixture.expectedScore,
        // A scoped single-grader fixture calibrates that verdict, including a
        // zero-weight hard gate. Its aggregate task score remains unchanged.
        observed: graderIds?.length === 1 ? result.components[0]! : result,
        result,
      });
    }

    const failures = results.filter(
      ({ label, expectedPassed, expectedRewardEligible, expectedScore, observed }) => {
        if (!fixtureScoreMatches(expectedScore, observed.score)) return true;
        if (label === "infrastructure_failure" && observed.score !== null) {
          return true;
        }
        if (
          typeof expectedPassed === "boolean"
          && observed.passed !== expectedPassed
        ) {
          return true;
        }
        return (
          typeof expectedRewardEligible === "boolean"
          && observed.rewardEligible !== expectedRewardEligible
        );
      },
    );
    const infrastructureSafetyPassed = results
      .filter((item) => item.label === "infrastructure_failure")
      .every(
        (item) =>
          item.observed.score === null && item.observed.rewardEligible === false,
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
            !item.observed.passed && (item.observed.score ?? 0) < 0.8,
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
        (failure.expectedScore === undefined ? "" : `Expected score=${String(failure.expectedScore)}; received score=${String(failure.observed.score)}. `)
        + `Expected passed=${String(failure.expectedPassed)} and `
        + `rewardEligible=${String(failure.expectedRewardEligible)}; received `
        + `passed=${String(failure.observed.passed)} and `
        + `rewardEligible=${String(failure.observed.rewardEligible)}.`,
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
