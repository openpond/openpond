import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { computeTasksetHash, runBaseline } from "../packages/taskset-sdk/src";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  TasksetSchema,
  type Taskset,
} from "../packages/contracts/src";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { buildTasksetReadiness } from "../apps/server/src/training/readiness";
import { createTrainingBaselineAttemptRunner } from "../apps/server/src/training/task-baseline-attempt-runner";
import { gradeTasksetBaselineAttempt } from "../apps/server/src/training/task-baseline-grade-runner";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  resolveCrossSystemTrainTask,
  type CrossSystemFrontierModelStream,
} from "../apps/server/src/training/cross-system-operations";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("baseline evaluator", () => {
  test("automatically audits deterministic graders and makes SFT ready without a baseline", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture();
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any) });

    const readiness = await service.readiness(taskset.id);

    expect(readiness).toMatchObject({ ready: true, recommendedMethod: "sft", trainingPath: { primaryMethod: "sft", bootstrap: null }, baselineReportId: null, blockers: [] });
    expect((await store.listGraderAuditReports(taskset.id))[0]).toMatchObject({ passed: true });
    expect(await store.getTaskset(taskset.id)).toMatchObject({ status: "ready", readiness: { ready: true } });
  }));

  test("preserves GRPO as primary while representing local SFT only as a trajectory bootstrap", async () => withTrainingStore(async ({ store }) => {
    const base = tasksetFixture();
    const draft = TasksetSchema.parse({
      ...base,
      contentHash: "00000000",
      capabilities: { ...base.capabilities, supportedSignals: ["demonstration", "reward"], compatibleMethods: ["grpo", "sft"], requiresTools: true, requiresState: true },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
    });
    const taskset = TasksetSchema.parse({ ...draft, contentHash: computeTasksetHash(draft) });
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any) });

    const readiness = await service.readiness(taskset.id);

    expect(readiness).toMatchObject({
      ready: true,
      recommendedMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: { method: "sft", purpose: "trajectory_bootstrap", demonstrationRefs: ["demo_train"] } },
    });
    expect(readiness.compatibleDestinationClasses).not.toContain("local_cpu_fixture");
    expect(readiness.trainingPath?.bootstrap?.limitations.join(" ")).toContain("does not satisfy the primary GRPO recommendation");
  }));

  test("allows GRPO readiness without relabeling failed policy outputs as demonstrations", async () => withTrainingStore(async ({ store }) => {
    const base = tasksetFixture();
    const draft = TasksetSchema.parse({
      ...base,
      contentHash: "00000000",
      capabilities: {
        ...base.capabilities,
        supportedSignals: ["reward"],
        compatibleMethods: ["grpo"],
        requiresTools: true,
        requiresState: true,
      },
      learningSignals: { ...base.learningSignals, demonstrations: [] },
      metadata: { ...base.metadata, trainingMethod: "grpo" },
    });
    const taskset = TasksetSchema.parse({ ...draft, contentHash: computeTasksetHash(draft) });
    await store.upsertTaskset(taskset);
    const service = createTaskEvaluationService({
      store,
      loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any),
    });

    const readiness = await service.readiness(taskset.id);

    expect(readiness).toMatchObject({
      ready: true,
      recommendedMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: null },
      blockers: [],
    });
    expect(readiness.warnings.join(" ")).toContain("reward variance");
  }));

  test("runs repeated models/seeds and reports pass@k, reward, failures, cost, and interventions", async () => {
    const taskset = tasksetFixture();
    let index = 0;
    const result = await runBaseline({ taskset, models: [{ providerId: "custom-openai-compatible", modelId: "fixture" }], seeds: [1, 2], attemptsPerTask: 2, runAttempt: async ({ task, seed, attempt }) => attemptFixture({ id: `attempt_${index++}`, taskId: task.id, seed, attempt, output: attempt % 2 ? { text: "wrong" } : task.expectedOutput ?? {}, costUsd: 0.01, userInterventions: attempt }) });
    expect(result.attempts).toHaveLength(4);
    expect(result.report.passAtK).toMatchObject({ "1": 1, "2": 1 });
    expect(result.report.reward).toMatchObject({ count: 4, mean: 0.5, variance: 0.25 });
    expect(result.report.totalCostUsd).toBeCloseTo(0.04);
    expect(result.report.userInterventions).toBe(2);
  });

  test("excludes Cross-System schema and budget failures from baseline reward statistics", async () => {
    const { taskset } = crossSystemBaselineTaskset();
    let index = 0;
    const outcomes = [
      { outcome: "correct", reward: 1.1, rewardEligible: true },
      { outcome: "incorrect", reward: 0, rewardEligible: true },
      { outcome: "tool_schema_violation", reward: null, rewardEligible: false },
      { outcome: "budget_exhausted", reward: null, rewardEligible: false },
    ] as const;
    const result = await runBaseline({
      taskset,
      models: [{ providerId: "openpond", modelId: "openpond-chat" }],
      seeds: [0, 1, 2, 3],
      attemptsPerTask: 1,
      runAttempt: async ({ task, seed, attempt }) => {
        const verified = outcomes[index++]!;
        return attemptFixture({
          id: `cross_system_grade_${seed}`,
          tasksetId: taskset.id,
          taskId: task.id,
          split: task.split,
          seed,
          attempt,
          output: task.expectedOutput ?? {},
          metadata: {
            execution: "taskset_baseline_tool_loop",
            verifierOutcome: verified.outcome,
            verifierReward: verified.reward,
            verifierRewardEligible: verified.rewardEligible,
          },
        });
      },
      gradeAttempt: gradeTasksetBaselineAttempt,
    });

    expect(result.grades.map((grade) => ({
      score: grade.score,
      passed: grade.passed,
      rewardEligible: grade.rewardEligible,
      failureClass: grade.failureClass,
    }))).toEqual([
      { score: 1, passed: true, rewardEligible: true, failureClass: null },
      { score: 0, passed: false, rewardEligible: true, failureClass: "policy_failure" },
      { score: null, passed: false, rewardEligible: false, failureClass: "policy_failure" },
      { score: null, passed: false, rewardEligible: false, failureClass: "policy_failure" },
    ]);
    expect(result.report.passAtK).toEqual({ "1": 0.25 });
    expect(result.report.reward).toEqual({
      count: 2,
      mean: 0.5,
      min: 0,
      max: 1,
      variance: 0.25,
    });
  });

  test("regrades immutable Cross-System attempts without rerunning the harness", async () => withTrainingStore(async ({ store, directory }) => {
    const { taskset } = crossSystemBaselineTaskset();
    await store.upsertTaskset(taskset);
    let rolloutCalls = 0;
    const service = createTaskEvaluationService({
      store,
      storeDir: directory,
      runAttempt: async ({ task, seed, attempt }) => {
        rolloutCalls += 1;
        return attemptFixture({
          id: "cross_system_regrade_attempt",
          tasksetId: taskset.id,
          taskId: task.id,
          split: task.split,
          seed,
          attempt,
          output: task.expectedOutput ?? {},
          artifactRefs: ["runtime_trace_regrade"],
          metadata: {
            execution: "taskset_baseline_tool_loop",
            verifierOutcome: "tool_schema_violation",
            verifierReward: null,
            verifierRewardEligible: false,
          },
        });
      },
    });
    const original = await service.baseline({
      tasksetId: taskset.id,
      models: [{ providerId: "openpond", modelId: "openpond-chat" }],
      seeds: [0],
      attemptsPerTask: 1,
    });

    const regraded = await service.regradeBaseline({
      tasksetId: taskset.id,
      baselineReportId: original.report.id,
    });

    expect(rolloutCalls).toBe(1);
    expect(regraded.report.attemptRefs).toEqual(original.report.attemptRefs);
    expect(regraded.report.passAtK).toEqual({ "1": 0 });
    expect(regraded.report.reward).toEqual({
      count: 0,
      mean: null,
      min: null,
      max: null,
      variance: null,
    });
    expect(regraded.grades[0]).toMatchObject({
      score: null,
      passed: false,
      rewardEligible: false,
      failureClass: "policy_failure",
    });
  }));

  test("runs Cross-System Taskset baselines through the bounded tool harness and preserves a runtime trace", async () => withTrainingStore(async ({ store, directory }) => {
    const { taskset, generatedTask } = crossSystemBaselineTaskset();
    await store.upsertTaskset(taskset);
    let plainTextCalls = 0;
    const stream: CrossSystemFrontierModelStream = async function* ({ messages }) {
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        yield {
          toolCalls: [{
            index: 0,
            id: "call_search_crm",
            type: "function",
            function: {
              name: "search_crm",
              arguments: JSON.stringify({
                query: "*",
                fields: ["account_id", "name"],
                cursor: null,
                limit: 50,
              }),
            },
          }],
        };
        return;
      }
      yield { text: `ANSWER: ${JSON.stringify(generatedTask.expectedAnswer)}` };
    };
    const runner = createTrainingBaselineAttemptRunner({
      store,
      storeDir: directory,
      modelText: async () => {
        plainTextCalls += 1;
        return "This path must not run.";
      },
      crossSystemStream: stream,
    });

    const result = await runner({
      tasksetId: taskset.id,
      task: taskset.tasks[0]!,
      model: { providerId: "openpond", modelId: "openpond-chat" },
      seed: 7,
      attempt: 0,
    });

    expect(plainTextCalls).toBe(0);
    expect(result.output.text).toBe(`ANSWER: ${JSON.stringify(generatedTask.expectedAnswer)}`);
    expect(result.metadata).toMatchObject({
      execution: "taskset_baseline_tool_loop",
      worldId: generatedTask.worldId,
      verifierOutcome: "correct",
      verifierRewardEligible: true,
    });
    const [artifact] = await store.listTaskAttemptArtifacts({ attemptId: result.id });
    expect(artifact).toMatchObject({
      kind: "runtime_trace",
      metadata: { containsPrivilegedOutcome: false },
    });
    const trace = JSON.parse(await readFile(artifact!.path, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(trace)).toContain("search_crm");
    expect(trace).not.toHaveProperty("expectedOutput");
    expect(() => resolveCrossSystemTrainTask(taskset, { rowId: taskset.tasks[0]!.id }))
      .toThrow("approved train task");
  }));

  test("retries one infrastructure-only Cross-System failure and retains the failed trace", async () => withTrainingStore(async ({ store, directory }) => {
    const { taskset, generatedTask } = crossSystemBaselineTaskset();
    await store.upsertTaskset(taskset);
    let calls = 0;
    const runner = createTrainingBaselineAttemptRunner({
      store,
      storeDir: directory,
      modelText: async () => {
        throw new Error("The plain text runner must not execute.");
      },
      crossSystemStream: async function* () {
        calls += 1;
        if (calls === 1) throw new Error("terminated");
        yield { text: `ANSWER: ${JSON.stringify(generatedTask.expectedAnswer)}` };
      },
    });

    const result = await runner({
      tasksetId: taskset.id,
      task: taskset.tasks[0]!,
      model: { providerId: "openpond", modelId: "openpond-chat" },
      seed: 7,
      attempt: 0,
    });

    expect(calls).toBe(2);
    expect(result.infrastructureError).toBeNull();
    expect(result.metadata).toMatchObject({
      verifierOutcome: "correct",
      infrastructureRetryAttempt: 1,
      priorInfrastructureErrors: ["terminated"],
    });
    const [artifact] = await store.listTaskAttemptArtifacts({ attemptId: result.id });
    const trace = JSON.parse(await readFile(artifact!.path, "utf8")) as {
      priorInfrastructureTrajectories: Array<{
        status: string;
        infrastructureError: string | null;
      }>;
    };
    expect(trace.priorInfrastructureTrajectories).toEqual([
      expect.objectContaining({
        status: "infrastructure_failure",
        infrastructureError: "terminated",
      }),
    ]);
  }));

  test("blocks training readiness when the grader audit fails", () => {
    const taskset = tasksetFixture();
    const readiness = buildTasksetReadiness({
      taskset,
      baseline: null,
      graderAudit: {
        schemaVersion: "openpond.graderAuditReport.v1",
        id: "grader_audit_failed_fixture",
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        fixtureRefs: ["fixture_negative"],
        gradeRefs: ["grade_false_positive"],
        passed: false,
        hackingChecksPassed: false,
        leakageChecksPassed: true,
        infrastructureSafetyPassed: true,
        failures: [{ fixtureId: "fixture_negative", label: "negative", gradeId: "grade_false_positive", reason: "The negative fixture incorrectly passed." }],
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["grader_audit_failed", "grader_hacking"]));
  });

  test("persists fixture audits, attempts, component grades, baseline, and readiness", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture();
    await store.upsertTaskset(taskset);
    let ordinal = 0;
    const service = createTaskEvaluationService({ store, loadProfileState: async () => ({ mode: "empty", sourcePath: null } as any), runAttempt: async ({ task, seed, attempt }) => attemptFixture({ id: `service_attempt_${ordinal++}`, tasksetId: taskset.id, taskId: task.id, split: task.split, seed, attempt, output: task.expectedOutput ?? {} }) });
    const result = await service.baseline({ tasksetId: taskset.id, models: [{ providerId: "custom-openai-compatible", modelId: "fixture" }], seeds: [1], attemptsPerTask: 1 });
    expect(result.readiness).toMatchObject({ ready: true, recommendedMethod: "sft", blockers: [] });
    expect((await store.listGraderAuditReports(taskset.id))[0]).toMatchObject({ passed: true, hackingChecksPassed: true, infrastructureSafetyPassed: true });
    expect(await store.listTaskAttempts(taskset.id)).toHaveLength(7);
    expect(await store.listGradeResultsForTaskset(taskset.id)).toHaveLength(7);
    expect((await store.getTaskset(taskset.id))?.status).toBe("ready");
  }));
});

function crossSystemBaselineTaskset(): {
  taskset: Taskset;
  generatedTask: ReturnType<typeof generateCrossSystemTasks>[number];
} {
  const base = tasksetFixture();
  const spec = {
    seed: 702,
    split: "frozen_eval" as const,
    difficulty: "easy" as const,
  };
  const world = generateCrossSystemWorld(spec);
  const generatedTask = generateCrossSystemTasks(world)
    .find((task) => task.phrasingVariant === 0)!;
  const authoredTask = {
    ...base.tasks[1]!,
    id: `authored_${generatedTask.id}`,
    clusterKey: generatedTask.clusterKey,
    split: generatedTask.split,
    input: { prompt: generatedTask.prompt },
    expectedOutput: {
      text: `ANSWER: ${JSON.stringify(generatedTask.expectedAnswer)}`,
    },
    metadata: {
      ...base.tasks[1]!.metadata,
      taskId: generatedTask.id,
      worldId: generatedTask.worldId,
      family: generatedTask.family,
    },
  };
  const draft = TasksetSchema.parse({
    ...base,
    id: "taskset_cross_system_baseline",
    tasks: [authoredTask],
    graderFixtures: base.graderFixtures.map((fixture) => ({
      ...fixture,
      taskId: authoredTask.id,
    })),
    environment: {
      ...base.environment,
      kind: "agent",
      stateful: true,
      toolNames: ["search_crm", "query_billing", "search_support", "run_python"],
      metadata: {
        flagship: "cross-system-operations",
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      },
    },
    capabilities: {
      ...base.capabilities,
      taskKind: "single_agent",
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo"],
      requiresTools: true,
      requiresState: true,
    },
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    readiness: null,
    contentHash: "00000000",
    metadata: {
      ...base.metadata,
      flagship: "cross-system-operations",
      trainingMethod: "grpo",
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      worldSpecs: [spec],
    },
  });
  return {
    taskset: TasksetSchema.parse({
      ...draft,
      contentHash: computeTasksetHash(draft),
    }),
    generatedTask,
  };
}
