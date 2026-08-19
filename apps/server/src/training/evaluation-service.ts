import path from "node:path";
import {
  aggregateEvaluationReceipts,
  compareBenchmarkRuns,
  createBenchmarkRunSummary,
  type BenchmarkRunPhase,
  type TasksetRelease,
} from "@openpond/evals";
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
  isModelJudgeExecutionError,
  type ModelJudgeRunner,
} from "@openpond/taskset-sdk";
import { loadOpenPondProfileState } from "@openpond/cloud";

import type { SqliteStore } from "../store/store.js";
import { artifactSplit, fixtureAttempt } from "./evaluation-helpers.js";
import { buildTasksetReadiness } from "./readiness.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";
import { gradeTasksetEvaluationAttempt } from "./task-evaluation-grade-runner.js";
import { runPostTrainingEvaluationAttempt } from "./task-evaluation-attempt-runner.js";
import { compileDesktopHarnessContext } from "./portable-evals-adapter.js";
import { persistCanonicalEvaluationEvidence } from "./canonical-evaluation-persistence.js";
import type {
  TasksetWorkAttemptRuntime,
  TasksetWorkModelStream,
  TasksetWorkRequiredOutputValidator,
} from "./taskset-work-attempt-runner.js";
import { linkHarnessReviewTaskset } from "./harness-review-taskset.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import { hostedModelJudgeCallCost } from "./evaluation-grader-cost.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import { reviewRefMatches, variance } from "./evaluation-service-statistics.js";

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
  additionalWorkToolDefinitions?: () => import("../openpond/model-tool-registry.js").ModelToolDefinition[];
  resolveTasksetRelease?: (taskset: import("@openpond/contracts").Taskset) => Promise<TasksetRelease | null>;
  resolveReleasedHarness?: () => Promise<{
    agentSnapshot: import("@openpond/harness").AgentSnapshot;
    harnessRelease: import("@openpond/harness").HarnessRelease;
    instructionContext?: string;
  } | null>;
}) {
  const graderUsageByAttemptId = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number | null;
  }>();

  async function execute(input: {
    tasksetId: string;
    taskId: string;
    model: ChatModelRef;
    reasoningEffort?: import("@openpond/contracts").CodexReasoningEffort | "none" | null;
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
    parentModelRunId?: string;
    toolEvidence?: import("./taskset-work-attempt-runner.js").TasksetWorkToolEvidence;
    hostedTokenPricing?: import("./hosted-token-pricing.js").HostedTokenPricing;
    releasedHarness?: {
      agentSnapshot: import("@openpond/harness").AgentSnapshot;
      harnessRelease: import("@openpond/harness").HarnessRelease;
      instructionContext?: string;
    };
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
    const releasedHarness = input.releasedHarness
      ?? await deps.resolveReleasedHarness?.()
      ?? null;
    const boundTasksetRelease = await deps.resolveTasksetRelease?.(taskset) ?? null;
    const profile = !releasedHarness && deps.loadProfileState ? await deps.loadProfileState() : null;
    const portable = compileDesktopHarnessContext({
      taskset,
      selectedTask: task,
      profile,
      releasedHarness,
      tasksetRelease: boundTasksetRelease,
      reasoningEffort: input.reasoningEffort ?? null,
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
        additionalToolDefinitions: deps.additionalWorkToolDefinitions?.(),
        toolEvidence: input.toolEvidence,
        harnessCapabilityReceipt: releasedHarness
          ? {
              harnessRelease: {
                id: releasedHarness.harnessRelease.id,
                contentHash: releasedHarness.harnessRelease.contentHash,
              },
              agentSnapshot: {
                id: releasedHarness.agentSnapshot.id,
                contentHash: releasedHarness.agentSnapshot.contentHash,
              },
              instructionAssets: releasedHarness.agentSnapshot.instructions,
              skillAssets: releasedHarness.agentSnapshot.skills,
              agentAssets: releasedHarness.agentSnapshot.agents,
              fileAssets: releasedHarness.harnessRelease.files,
              declaredToolNames: releasedHarness.agentSnapshot.toolDeclarations.map(
                (tool) => tool.name,
              ),
            }
          : undefined,
        hostedTokenPricing: input.hostedTokenPricing,
      },
      resultId: input.resultId,
      parentModelRunId: input.parentModelRunId,
      harnessInstructionContext: releasedHarness?.instructionContext,
      attemptInput: {
        tasksetId: taskset.id,
        task,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
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
      hostedTokenPricing: input.hostedTokenPricing,
    });
    const artifacts = await deps.store.listTaskAttemptArtifacts({
      attemptId: attempt.id,
    });
    const canonical = await persistCanonicalEvaluationEvidence({
      store: deps.store,
      storeDir: deps.storeDir,
      taskset,
      task,
      context: portable,
      attempt,
      grade: gradeResult,
      artifacts,
    });
    const receipt = canonical.attemptReceipt;
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
      attempt: canonical.attempt,
      grade: gradeResult,
      artifacts: canonical.artifacts,
      portable: {
        agentSnapshot: portable.agentSnapshot,
        harnessRelease: portable.harnessRelease,
        tasksetRelease: portable.tasksetRelease,
        environmentRelease: portable.environmentRelease,
        verifierSetRelease: portable.verifierSetRelease,
        runManifest: portable.runManifest,
        receipt,
        artifactManifest: canonical.artifactManifest,
        rewardReceipt: canonical.rewardReceipt,
        rolloutRecord: canonical.rolloutRecord,
        evaluationResult,
      },
    };
  }

  async function grade(input: {
    tasksetId: string;
    taskId: string;
    attempt: unknown;
    hostedTokenPricing?: HostedTokenPricing;
  }) {
    const taskset = await requireTaskset(input.tasksetId);
    const attempt = TaskAttemptResultSchema.parse(input.attempt);
    const task = await findTask(taskset, input.taskId, attempt.split);
    const customVerifier = await customVerifierFor(taskset.id);
    const rawUsages: unknown[] = [];
    let explicitCostUsd = 0;
    let modelJudgeCalls = 0;
    let modelJudgeCostAccounted = 0;
    const result = await gradeTasksetEvaluationAttempt({
      task,
      attempt,
      graders: taskset.graders,
      modelJudge: deps.modelJudge
        ? async (judgeInput) => {
            modelJudgeCalls += 1;
            let judged: Awaited<ReturnType<NonNullable<typeof deps.modelJudge>>>;
            try {
              judged = await deps.modelJudge!(judgeInput);
            } catch (error) {
              if (isModelJudgeExecutionError(error)) {
                if (Array.isArray(error.usage)) rawUsages.push(...error.usage);
                else if (error.usage !== undefined) rawUsages.push(error.usage);
                const callCostUsd = hostedModelJudgeCallCost({
                  costUsd: error.costUsd,
                  usage: error.usage,
                  pricing: input.hostedTokenPricing,
                });
                if (callCostUsd !== null) {
                  explicitCostUsd += callCostUsd;
                  modelJudgeCostAccounted += 1;
                }
              }
              throw error;
            }
            if (Array.isArray(judged.usage)) rawUsages.push(...judged.usage);
            else if (judged.usage !== undefined) rawUsages.push(judged.usage);
            const callCostUsd = hostedModelJudgeCallCost({
              costUsd: judged.costUsd,
              usage: judged.usage,
              pricing: input.hostedTokenPricing,
            });
            if (callCostUsd !== null) {
              explicitCostUsd += callCostUsd;
              modelJudgeCostAccounted += 1;
            }
            return judged;
          }
        : undefined,
      customVerifier,
      now: () => new Date().toISOString(),
    });
    await deps.store.saveTaskAttempt(attempt);
    await deps.store.saveGradeResult(result);
    const usage = rawUsages.reduce<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>(
      (total, raw) => {
        const normalized = normalizeModelUsageTokens(raw);
        total.inputTokens += normalized.promptTokens ?? 0;
        total.outputTokens += normalized.completionTokens ?? 0;
        total.totalTokens += normalized.totalTokens ?? 0;
        return total;
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    graderUsageByAttemptId.set(attempt.id, {
      ...usage,
      // Infrastructure and earlier hard-gate failures can skip the model
      // judge entirely. That is an authoritative zero-cost grading path, not
      // missing accounting. If a judge did run, retain fail-closed semantics
      // unless its hosted cost was actually observed.
      costUsd: modelJudgeCalls === 0
        ? 0
        : modelJudgeCostAccounted === modelJudgeCalls
          ? explicitCostUsd
          : null,
    });
    return result;
  }

  function consumeGraderUsage(attemptIds: readonly string[]) {
    const total = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null as number | null,
    };
    for (const attemptId of attemptIds) {
      const usage = graderUsageByAttemptId.get(attemptId);
      graderUsageByAttemptId.delete(attemptId);
      if (!usage) continue;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.totalTokens += usage.totalTokens;
      if (usage.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
    }
    return total;
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
      let judgeFailure: string | null = null;
      for (const [index, fixture] of fixtures.entries()) {
        if (judgeFailure) {
          results.push({
            fixtureId: fixture.id,
            expectedPassed: fixture.expectedPassed,
            passed: false,
            score: 0,
            feedback: `Not run because the judge failed on an earlier fixture: ${judgeFailure}`,
            matched: false,
          });
          continue;
        }
        const task = await findTask(
          taskset,
          fixture.taskId,
          artifactSplit(fixture),
        );
        const attempt = fixtureAttempt(taskset.id, fixture, index);
        try {
          const result = await deps.modelJudge({ grader, task, attempt });
          const criterionScores = result.criterionScores ?? [];
          const expectedCriterionIds = (task.evaluationCriteria ?? [])
            .filter((criterion) => criterion.scorerIds.includes(grader.id))
            .map((criterion) => criterion.id)
            .sort();
          const scoredCriterionIds = criterionScores
            .map((criterion) => criterion.criterionId)
            .sort();
          const criterionCoverageMatched =
            expectedCriterionIds.length === scoredCriterionIds.length
            && expectedCriterionIds.every((id, scoreIndex) => id === scoredCriterionIds[scoreIndex]);
          results.push({
            fixtureId: fixture.id,
            expectedPassed: fixture.expectedPassed,
            passed: result.passed,
            score: result.score,
            feedback: result.feedback,
            expectedCriterionIds,
            scoredCriterionIds,
            criterionCoverageMatched,
            matched: result.passed === fixture.expectedPassed && criterionCoverageMatched,
          });
        } catch (error) {
          judgeFailure = error instanceof Error ? error.message : String(error);
          results.push({
            fixtureId: fixture.id,
            expectedPassed: fixture.expectedPassed,
            passed: false,
            score: 0,
            feedback: judgeFailure,
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
          results: calibrationResults.map((result) => ({
            graderId: result.graderId,
            passed: result.passed,
            fixtures: result.results.map((fixture) => ({
              fixtureId: fixture.fixtureId,
              expectedPassed: fixture.expectedPassed,
              passed: fixture.passed,
              matched: fixture.matched,
              feedback: fixture.feedback,
              ...("criterionCoverageMatched" in fixture
                ? { criterionCoverageMatched: fixture.criterionCoverageMatched }
                : {}),
            })),
          })),
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
    if (updated.purpose !== "benchmark") {
      await buildTaskset(
        updated,
        path.join(deps.storeDir, "training", "tasksets", updated.id),
      );
    }
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
          const execution = await execute({
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
          });
          executions.push(execution);
        }
      }
    }
    const manifest = executions[0]!.portable.runManifest;
    if (executions.some((execution) => execution.portable.runManifest.contentHash !== manifest.contentHash)) {
      throw new Error("Baseline attempts did not share one frozen Run Manifest.");
    }
    const receipts = executions.map((execution) => execution.portable.receipt);
    const portableTaskset = executions[0]!.portable.tasksetRelease;
    const scores = receipts.flatMap((receipt) =>
      typeof receipt.metadata.score === "number" ? [receipt.metadata.score] : [],
    );
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
        environmentHash: contentHash(portableTaskset.environment),
        toolContractHash: contentHash(portableTaskset.tools),
        permissionContractHash: contentHash({
          connectedAppScopes: portableTaskset.policy.connectedAppScopes,
          networkPolicy: portableTaskset.environment.networkPolicy,
        }),
        policyHash: contentHash(portableTaskset.policy),
        verifierRef: {
          id: `verifier-${taskset.id}-r${taskset.revision}`,
          contentHash: contentHash(portableTaskset.graders),
        },
        scores,
        scoreVariance: variance(scores),
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

  async function executeBenchmark(input: {
    tasksetId: string;
    phase: BenchmarkRunPhase;
    model: ChatModelRef;
    reasoningEffort?: import("@openpond/contracts").CodexReasoningEffort | "none" | null;
    split?: DatasetSplit;
    seeds?: number[];
    repetitions?: number;
    taskIds?: string[];
    sampling?: {
      maxOutputTokens: number;
      temperature: number;
      topP: number;
    };
    signal?: AbortSignal;
    releasedHarness?: {
      agentSnapshot: import("@openpond/harness").AgentSnapshot;
      harnessRelease: import("@openpond/harness").HarnessRelease;
      instructionContext?: string;
    };
    parentModelRunId?: string;
    toolEvidence?: import("./taskset-work-attempt-runner.js").TasksetWorkToolEvidence;
    hostedTokenPricing?: import("./hosted-token-pricing.js").HostedTokenPricing;
    onAttemptComplete?: (
      result: Awaited<ReturnType<typeof execute>>,
    ) => Promise<void> | void;
  }) {
    const taskset = await requireTaskset(input.tasksetId);
    if (taskset.purpose !== "benchmark" || !taskset.benchmark) {
      throw new Error("This Taskset does not define a benchmark protocol.");
    }
    const split = input.split ?? taskset.benchmark.evaluationSplit;
    const requestedTaskIds = input.taskIds?.length
      ? new Set(input.taskIds)
      : null;
    const tasks = taskset.tasks.filter(
      (task) =>
        task.split === split
        && (!requestedTaskIds || requestedTaskIds.has(task.id)),
    );
    if (
      requestedTaskIds
      && tasks.length !== requestedTaskIds.size
    ) {
      throw new Error("Benchmark task selection contains an id outside the pinned split.");
    }
    if (!tasks.length) throw new Error(`Benchmark split ${split} has no cases.`);
    const seeds = [...new Set(input.seeds?.length ? input.seeds : [17])].slice(0, 100);
    const repetitions = Math.max(1, Math.min(20, Math.trunc(input.repetitions ?? 1)));
    const admittedAt = new Date().toISOString();
    const executions: Awaited<ReturnType<typeof execute>>[] = [];
    for (const task of tasks) {
      for (const seed of seeds) {
        for (let attempt = 0; attempt < repetitions; attempt += 1) {
          if (input.signal?.aborted) throw input.signal.reason;
          const execution = await execute({
            tasksetId: taskset.id,
            taskId: task.id,
            model: input.model,
            reasoningEffort: input.reasoningEffort ?? null,
            seed,
            attempt,
            sampling: input.sampling,
            signal: input.signal,
            releasedHarness: input.releasedHarness,
            admittedAt,
            parentModelRunId: input.parentModelRunId,
            toolEvidence: input.toolEvidence,
            hostedTokenPricing: input.hostedTokenPricing,
            resultId: `benchmark-attempt-${contentHash({
              tasksetRelease: taskset.benchmark.releaseHash,
              phase: input.phase,
              model: input.model,
              reasoningEffort: input.reasoningEffort ?? null,
              split,
              taskId: task.id,
              seed,
              attempt,
              admittedAt,
            }).slice(0, 24)}`,
          });
          executions.push(execution);
          await input.onAttemptComplete?.(execution);
        }
      }
    }
    const manifest = executions[0]!.portable.runManifest;
    if (executions.some((execution) => execution.portable.runManifest.contentHash !== manifest.contentHash)) {
      throw new Error("Benchmark attempts did not share one pinned Run Manifest.");
    }
    const receipts = executions.map((execution) => execution.portable.receipt);
    const evaluationResult = aggregateEvaluationReceipts({
      id: `benchmark-evaluation-${contentHash({
        manifest: manifest.contentHash,
        phase: input.phase,
        receipts: receipts.map((receipt) => receipt.contentHash),
      }).slice(0, 24)}`,
      manifest,
      receipts,
      metadata: {
        kind: "benchmark",
        phase: input.phase,
        split,
        reasoningEffort: input.reasoningEffort ?? null,
        sourceTasksetId: taskset.id,
        sourceTasksetRevision: taskset.revision,
        sourceTasksetHash: taskset.contentHash,
        benchmarkDefinitionId: taskset.benchmark.definitionId,
        admittedAt,
        parentModelRunId: input.parentModelRunId ?? null,
      },
    });
    await deps.store.saveEvaluationResult({
      tasksetId: taskset.id,
      kind: input.phase,
      result: evaluationResult,
      createdAt: admittedAt,
    });
    const run = createBenchmarkRunSummary({
      id: `benchmark-run-${evaluationResult.contentHash.slice(0, 24)}`,
      phase: input.phase,
      evaluation: evaluationResult,
      receipts,
      reasoningEffort: input.reasoningEffort ?? null,
      protocol: {
        split,
        taskIds: tasks.map((task) => task.id),
        seeds: seeds.map(String),
        repetitions,
        runtimeTargetHash: contentHash(manifest.runtimeTarget),
        environmentHash: contentHash(executions[0]!.portable.tasksetRelease.environment),
        toolContractHash: contentHash({
          tasksetTools: executions[0]!.portable.tasksetRelease.tools,
          harnessTools: executions[0]!.portable.harnessRelease.tools,
        }),
        limitsHash: contentHash(manifest.limits),
      },
      createdAt: admittedAt,
      metadata: {
        sourceTasksetId: taskset.id,
        split,
        seeds,
        repetitions,
        parentModelRunId: input.parentModelRunId ?? null,
      },
    });
    await deps.store.saveBenchmarkRun({ tasksetId: taskset.id, run });

    const priorRuns = await deps.store.listBenchmarkRuns(taskset.id);
    const baseline = input.phase === "baseline"
      ? run
      : priorRuns.find((candidate) =>
          candidate.phase === "baseline"
          && candidate.tasksetRelease.contentHash === run.tasksetRelease.contentHash
          && candidate.model.provider === run.model.provider
          && candidate.model.model === run.model.model
          && candidate.reasoningEffort === run.reasoningEffort
          && contentHash(candidate.protocol) === contentHash(run.protocol)
        ) ?? null;
    const candidate = input.phase === "candidate"
      ? run
      : priorRuns.find((item) =>
          item.phase === "candidate"
          && item.tasksetRelease.contentHash === run.tasksetRelease.contentHash
          && item.model.provider === run.model.provider
          && item.model.model === run.model.model
          && item.reasoningEffort === run.reasoningEffort
          && contentHash(item.protocol) === contentHash(run.protocol)
        ) ?? null;
    const comparison = baseline && candidate
      ? compareBenchmarkRuns({
          id: `benchmark-comparison-${contentHash([baseline.contentHash, candidate.contentHash]).slice(0, 24)}`,
          baseline,
          candidate,
          primaryMetric: taskset.benchmark.primaryMetric,
          qualityGate: taskset.benchmark.qualityGate,
          createdAt: admittedAt,
          metadata: {
            sourceTasksetId: taskset.id,
            benchmarkDefinitionId: taskset.benchmark.definitionId,
          },
        })
      : null;
    if (comparison) {
      await deps.store.saveBenchmarkComparison({ tasksetId: taskset.id, comparison });
    }
    return { evaluationResult, run, comparison, attempts: executions };
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
    if (tasksetRoot && taskset.purpose !== "benchmark") {
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
    consumeGraderUsage,
    auditFixtures,
    calibrateModelJudges,
    readiness,
    executeBaseline,
    executeBenchmark,
    close: async () => {},
  };
}
