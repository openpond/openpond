import path from "node:path";
import {
  BaselineReportSchema,
  GraderAuditReportSchema,
  TasksetSchema,
  TaskAttemptResultSchema,
  type ChatModelRef,
  type GraderSpec,
  type TaskAttemptResult,
  type TaskDataRecord,
} from "@openpond/contracts";
import { buildTaskset, computeTasksetHash, contentHash, gradeAttempt, runBaseline, type BaselineAttemptRunner, type ModelJudgeRunner } from "@openpond/taskset-sdk";
import { loadOpenPondProfileState } from "@openpond/cloud";
import type { SqliteStore } from "../store/store.js";
import { buildTasksetReadiness } from "./readiness.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";

export function createTaskEvaluationService(deps: {
  store: SqliteStore;
  runAttempt?: BaselineAttemptRunner | null;
  modelJudge?: ModelJudgeRunner | null;
  loadProfileState?: typeof loadOpenPondProfileState;
}) {
  async function grade(input: { tasksetId: string; taskId: string; attempt: unknown }) {
    const taskset = await requireTaskset(input.tasksetId);
    const task = taskset.tasks.find((item) => item.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const attempt = TaskAttemptResultSchema.parse(input.attempt);
    const customVerifier = await customVerifierFor(taskset.id);
    const result = await gradeAttempt({
      task,
      attempt,
      graders: taskset.graders,
      modelJudge: deps.modelJudge ?? undefined,
      customVerifier,
    });
    await deps.store.saveTaskAttempt(attempt);
    await deps.store.saveGradeResult(result);
    return result;
  }

  async function baseline(input: { tasksetId: string; models: ChatModelRef[]; seeds?: number[]; attemptsPerTask?: number }) {
    if (!deps.runAttempt) throw new Error("No baseline model runner is configured.");
    const taskset = await requireTaskset(input.tasksetId);
    const fixtureAudit = await auditFixtures({ tasksetId: taskset.id });
    const execution = await runBaseline({ taskset, models: input.models, seeds: input.seeds?.length ? input.seeds : [0, 1, 2], attemptsPerTask: Math.max(1, Math.min(10, input.attemptsPerTask ?? 3)), runAttempt: deps.runAttempt, modelJudge: deps.modelJudge ?? undefined, customVerifier: await customVerifierFor(taskset.id) });
    const baselineFlags = auditFlags(execution.attempts, execution.grades);
    const auditedReport = BaselineReportSchema.parse({ ...execution.report, hackingChecksPassed: baselineFlags.hackingChecksPassed && fixtureAudit.report.hackingChecksPassed && fixtureAudit.report.infrastructureSafetyPassed, leakageChecksPassed: baselineFlags.leakageChecksPassed && fixtureAudit.report.leakageChecksPassed });
    for (const attempt of execution.attempts) await deps.store.saveTaskAttempt(attempt);
    for (const result of execution.grades) await deps.store.saveGradeResult(result);
    await deps.store.saveBaselineReport(auditedReport);
    const readiness = buildTasksetReadiness({ taskset, baseline: auditedReport, graderAudit: fixtureAudit.report });
    await deps.store.saveReadinessReport(readiness);
    await deps.store.upsertTaskset({ ...taskset, status: readiness.ready ? "ready" : "needs_review", readiness, updatedAt: new Date().toISOString() });
    return { report: auditedReport, readiness, attempts: execution.attempts, grades: execution.grades };
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
      const task = taskset.tasks.find((item) => item.id === fixture.taskId);
      if (!task) throw new Error(`Task ${fixture.taskId} not found.`);
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
        const task = taskset.tasks.find((item) => item.id === fixture.taskId);
        if (!task) continue;
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
    const unhashed = TasksetSchema.parse({ ...taskset, graders, status: "needs_review", readiness: null, contentHash: "00000000", updatedAt: timestamp });
    const updated = TasksetSchema.parse({ ...unhashed, contentHash: computeTasksetHash(unhashed) });
    const profile = await (deps.loadProfileState ?? loadOpenPondProfileState)();
    if (!profile.sourcePath) throw new Error("A local source-owned Taskset is required for judge calibration.");
    await buildTaskset(updated, path.join(profile.sourcePath, "tasksets", updated.id));
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
    const report = buildTasksetReadiness({ taskset, baseline: baselineReports[0] ?? null, graderAudit });
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
  async function customVerifierFor(tasksetId: string) {
    const profile = await (deps.loadProfileState ?? loadOpenPondProfileState)();
    const tasksetRoot = profile.sourcePath ? path.join(profile.sourcePath, "tasksets", tasksetId) : null;
    return tasksetRoot
      ? ({ grader, task, attempt }: Parameters<NonNullable<Parameters<typeof gradeAttempt>[0]["customVerifier"]>>[0]) => runSandboxedVerifier({ grader, task, attempt, allowedRoot: tasksetRoot })
      : undefined;
  }
  return { grade, baseline, auditFixtures, calibrateModelJudges, readiness };
}

function fixtureAttempt(tasksetId: string, fixture: { id: string; taskId: string; label: string; output: Record<string, unknown>; infrastructureError: string | null }, index: number) {
  const timestamp = new Date().toISOString();
  return TaskAttemptResultSchema.parse({ schemaVersion: "openpond.taskAttempt.v1", id: `fixture_attempt_${fixture.id}_${index}`, tasksetId, taskId: fixture.taskId, split: "frozen_eval", attempt: index, seed: 0, modelRef: null, startedAt: timestamp, completedAt: timestamp, output: fixture.output, runtimeEventRefs: [], artifactRefs: [], privilegedOutcomeRef: null, infrastructureError: fixture.infrastructureError, costUsd: 0, latencyMs: 0, userInterventions: 0, metadata: { fixtureLabel: fixture.label } });
}

function auditFlags(attempts: TaskAttemptResult[], grades: Awaited<ReturnType<typeof gradeAttempt>>[]) {
  const infraAttempts = attempts.filter((attempt) => attempt.infrastructureError);
  const infrastructureSafe = infraAttempts.every((attempt) => { const grade = grades.find((item) => item.attemptId === attempt.id); return grade?.score === null && grade.rewardEligible === false; });
  const suspicious = grades.some((grade) => grade.feedback.some((item) => /reward hack|prompt injection/i.test(item)) && (grade.score ?? 0) >= 0.8);
  const leakage = grades.some((grade) => grade.feedback.some((item) => /privileged.*leak|hidden grader.*leak/i.test(item)));
  return { hackingChecksPassed: infrastructureSafe && !suspicious, leakageChecksPassed: !leakage };
}
