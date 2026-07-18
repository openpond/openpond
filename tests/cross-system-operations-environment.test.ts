import { describe, expect, test } from "vitest";
import {
  CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_NAMES,
  CrossSystemTrajectorySchema,
  DEFAULT_CROSS_SYSTEM_WORLD_SPECS,
  TaskDesignProposalSchema,
} from "@openpond/contracts";
import {
  buildCrossSystemBootstrapDataset,
  buildExpertCrossSystemTrajectories,
  CrossSystemEnvironment,
  CrossSystemToolError,
  crossSystemAdversarialAnswers,
  crossSystemGeneratedTaskFiles,
  crossSystemTrainingSourceMetadata,
  generateCrossSystemSuite,
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  recordFixtureBaselineSources,
  runScriptedCrossSystemBaseline,
  verifyCrossSystemTrajectory,
} from "../apps/server/src/training/cross-system-operations";
import { createTaskMinerService } from "../apps/server/src/training/task-miner";
import { crossSystemStructuredExample, enrichCrossSystemProposal } from "../apps/server/src/training/task-creator";
import { sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("Cross-System Operations environment", () => {
  test("generates deterministic, balanced, split-isolated worlds with controlled decoys", () => {
    const first = generateCrossSystemWorld({ seed: 41, split: "train", difficulty: "hard" });
    const repeated = generateCrossSystemWorld({ seed: 41, split: "train", difficulty: "hard" });
    const frozen = generateCrossSystemWorld({ seed: 77, split: "frozen_eval", difficulty: "hard" });
    const easy = generateCrossSystemWorld({ seed: 41, split: "train", difficulty: "easy" });
    expect(repeated).toEqual(first);
    expect(first.toolContractHash).toBe(CROSS_SYSTEM_TOOL_CONTRACT_HASH);
    expect(first.accounts.length).toBeGreaterThan(easy.accounts.length);
    expect(first.invoices.some((invoice) => invoice.status === "scheduled")).toBe(true);
    expect(first.supportCases.some((supportCase) => supportCase.state === "closed")).toBe(true);
    expect(first.accounts.filter((account) => account.name === "Atlas Operations").length).toBe(2);
    expect(new Set(first.accounts.map((account) => account.accountId)).intersection(new Set(frozen.accounts.map((account) => account.accountId))).size).toBe(0);
    const tasks = generateCrossSystemTasks(first);
    expect(tasks).toHaveLength(15);
    expect(new Set(tasks.map((task) => task.family)).size).toBe(5);
    expect(tasks.every((task) => task.budget.maxTurns === 15 && task.clusterKey.startsWith(first.id))).toBe(true);
    expect(() => generateCrossSystemSuite({ trainSeeds: [1], validationSeeds: [1], frozenEvalSeeds: [2] })).toThrow("reused");
  });

  test("varies renewal-risk membership and exposure without changing legacy worlds", () => {
    const legacy = generateCrossSystemWorld({
      seed: 601,
      split: "train",
      difficulty: "easy",
    });
    const first = generateCrossSystemWorld({
      seed: 601,
      split: "train",
      difficulty: "easy",
      scenarioProfile: "renewal_risk_v2",
    });
    const repeated = generateCrossSystemWorld({
      seed: 601,
      split: "train",
      difficulty: "easy",
      scenarioProfile: "renewal_risk_v2",
    });
    const second = generateCrossSystemWorld({
      seed: 602,
      split: "train",
      difficulty: "easy",
      scenarioProfile: "renewal_risk_v2",
    });
    const renewal = (world: typeof first) =>
      world.groundTruth.renewal_exposure.expectedAnswer as {
        account_ids: string[];
        total_overdue_usd_cents: number;
      };

    expect(repeated).toEqual(first);
    expect(first).not.toEqual(legacy);
    expect(renewal(first).account_ids).toHaveLength(2);
    expect(renewal(second).account_ids).toHaveLength(3);
    expect(renewal(first).total_overdue_usd_cents)
      .not.toBe(renewal(second).total_overdue_usd_cents);
    expect(renewal(first).account_ids.every((id) => id.startsWith("train_601_")))
      .toBe(true);
  });

  test("makes the renewal-risk join explicit and exact across seeds and difficulty", async () => {
    const specs = [
      { seed: 601, split: "train" as const, difficulty: "easy" as const },
      { seed: 625, split: "train" as const, difficulty: "medium" as const },
      { seed: 650, split: "train" as const, difficulty: "hard" as const },
      { seed: 617, split: "train" as const, difficulty: "easy" as const },
      { seed: 633, split: "train" as const, difficulty: "medium" as const },
      { seed: 641, split: "train" as const, difficulty: "hard" as const },
      { seed: 649, split: "train" as const, difficulty: "hard" as const },
    ].map((spec) => ({ ...spec, scenarioProfile: "renewal_risk_v2" as const }));
    const worlds = specs.map(generateCrossSystemWorld);
    const tasks = worlds.flatMap((world) =>
      generateCrossSystemTasks(world).filter((task) =>
        task.family === "renewal_exposure" && task.phrasingVariant === 0
      )
    );
    const expert = await buildExpertCrossSystemTrajectories({ worlds, tasks });

    expect(expert.results).toHaveLength(specs.length);
    expect(expert.results.every((result) =>
      result.outcome === "correct" && result.exactAnswer
    )).toBe(true);
    expert.trajectories.forEach((trajectory, index) => {
      expect(trajectory.steps.flatMap((step) =>
        step.kind === "tool_call" ? [step.name] : []
      )).toEqual([
        "search_crm",
        "query_billing",
        "search_support",
        "run_python",
      ]);
      const pythonResult = trajectory.steps.find((step) =>
        step.kind === "tool_result" && step.name === "run_python"
      );
      expect(
        (pythonResult?.kind === "tool_result"
          ? pythonResult.result as { result?: unknown }
          : null)?.result,
      ).toEqual(tasks[index]?.expectedAnswer);
    });
  });

  test("shards the 30/10/10 portable suite below the Taskset file limit", () => {
    const worlds = DEFAULT_CROSS_SYSTEM_WORLD_SPECS.map(generateCrossSystemWorld);
    const files = crossSystemGeneratedTaskFiles({
      worlds,
      tasks: worlds.flatMap(generateCrossSystemTasks),
    });
    expect(files.every((file) => file.content.length <= 250_000)).toBe(true);
    expect(files.map((file) => file.path)).toContain("environment/worlds.json");
    expect(files.some((file) => file.path.startsWith("environment/worlds/"))).toBe(true);
    const manifest = JSON.parse(
      files.find((file) => file.path === "environment/worlds.json")!.content,
    ) as { count: number; files: string[] };
    expect(manifest.count).toBe(10);
    expect(manifest.files).toHaveLength(10);
  });

  test("enforces schemas, cursors, row/byte/turn budgets, and a persistent standard-library-only Python sandbox", async () => {
    const world = generateCrossSystemWorld({ seed: 9, split: "train", difficulty: "easy" });
    const task = generateCrossSystemTasks(world)[0]!;
    const environment = new CrossSystemEnvironment({ attemptId: "attempt_bounds", world, task });
    try {
      const first = await environment.execute("search_crm", { query: "*", fields: ["account_id", "name"], cursor: null, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(typeof first.next_cursor).toBe("string");
      const second = await environment.execute("search_crm", { query: "*", fields: ["account_id", "name"], cursor: first.next_cursor, limit: 2 });
      expect(second.items).toHaveLength(2);
      await expect(environment.execute("search_crm", { query: "*", fields: ["account_id"], cursor: "tampered", limit: 2 })).rejects.toMatchObject({ code: "cursor_invalid" });
      await expect(environment.execute("query_billing", { account_ids: [], date_range: { from: "2026-01-01", to: "2026-12-31" }, status: ["overdue"], cursor: null, limit: 5 })).rejects.toMatchObject({ code: "schema_violation" });
      const overdueOnly = await environment.execute("query_billing", {
        account_ids: world.accounts.map((account) => account.accountId),
        date_range: { from: "2025-01-01", to: world.referenceDate },
        status: ["overdue"],
        cursor: null,
        limit: 50,
      });
      expect(overdueOnly.items).not.toHaveLength(0);
      expect(overdueOnly.items?.every((item) =>
        (item as { kind?: string; status?: string }).kind === "invoice"
        && (item as { status?: string }).status === "overdue",
      )).toBe(true);
      expect(await environment.execute("run_python", { code: "counter = 4\n_result = counter" })).toMatchObject({ result: 4 });
      expect(await environment.execute("run_python", { code: "counter += 3\n_result = counter" })).toMatchObject({ result: 7 });
      await expect(environment.execute("run_python", { code: "import socket\n_result = socket.socket()" })).rejects.toBeInstanceOf(CrossSystemToolError);
      expect(environment.evidence.every((item) => item.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH)).toBe(true);
    } finally {
      await environment.close();
    }
  });

  test("separates exact policy reward from parse, schema, budget, cancellation, and infrastructure outcomes", async () => {
    const world = generateCrossSystemWorld({ seed: 12, split: "frozen_eval", difficulty: "medium" });
    const task = generateCrossSystemTasks(world)[0]!;
    const base = {
      schemaVersion: "openpond.crossSystemOperations.v1" as const,
      id: "trajectory_exact",
      worldId: world.id,
      taskId: task.id,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      modelRef: null,
      status: "completed" as const,
      steps: [{ kind: "final" as const, turn: 1, content: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` }],
      startedAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:00:01.000Z",
      infrastructureError: null,
      metadata: {},
    };
    const exact = verifyCrossSystemTrajectory({ task, trajectory: CrossSystemTrajectorySchema.parse(base) });
    expect(exact).toMatchObject({ outcome: "correct", exactAnswer: true, rewardEligible: true });
    expect(exact.reward).toBeGreaterThan(1);
    const parse = verifyCrossSystemTrajectory({ task, trajectory: CrossSystemTrajectorySchema.parse({ ...base, id: "trajectory_parse", steps: [{ kind: "final", turn: 1, content: "not an answer" }] }) });
    expect(parse).toMatchObject({ outcome: "parse_failure", reward: 0, exactAnswer: false });
    const infrastructure = verifyCrossSystemTrajectory({ task, trajectory: CrossSystemTrajectorySchema.parse({ ...base, id: "trajectory_infra", status: "infrastructure_failure", steps: [], infrastructureError: "worker unavailable" }) });
    expect(infrastructure).toMatchObject({ outcome: "infrastructure_failure", reward: null, rewardEligible: false });
    expect(crossSystemAdversarialAnswers(task).map((fixture) => fixture.label)).toEqual(["negative", "boundary", "adversarial", "prompt_injection", "infrastructure_failure"]);
  });

  test("creates reward variance and only structured approved successful bootstrap records", async () => {
    const suite = generateCrossSystemSuite({ trainSeeds: [11], validationSeeds: [], frozenEvalSeeds: [29], difficulties: ["hard"] });
    const baseline = await runScriptedCrossSystemBaseline({ worlds: suite.worlds, tasks: suite.tasks });
    expect(new Set(baseline.trajectories.map((trajectory) => trajectory.metadata.scriptedOutcome))).toEqual(new Set(["correct", "incorrect", "inefficient"]));
    expect(baseline.report.reward.variance).toBeGreaterThan(0);
    expect(baseline.report.reward.min).toBe(0);
    expect(baseline.report.reward.max).toBeGreaterThan(1);
    const approved = baseline.trajectories.filter((trajectory) => trajectory.metadata.approved === true).map((trajectory) => trajectory.id);
    const records = buildCrossSystemBootstrapDataset({ tasks: suite.tasks, trajectories: baseline.trajectories, results: baseline.results, approvedTrajectoryIds: approved, approvedBy: "local_user", approvedAt: "2026-07-13T00:00:00.000Z" });
    expect(records.length).toBe(baseline.results.filter((result) => result.outcome === "correct").length);
    expect(records.every((record) => record.messages[0]?.role === "system" && record.messages[0].content === CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT)).toBe(true);
    expect(records.every((record) => record.messages.some((message) => message.role === "tool") && record.messages.some((message) => message.tool_calls?.length))).toBe(true);
    expect(records.every((record) => record.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH)).toBe(true);
    const renewal = records.find((record) =>
      record.taskId.includes("renewal_exposure"));
    expect(renewal?.messages.filter((message) =>
      message.tool_calls?.some((call) => call.function.name === "run_python"),
    )).toHaveLength(1);
    expect(renewal?.messages.some((message) =>
      message.role === "tool"
      && message.content.includes("total_overdue_usd_cents"),
    )).toBe(true);
  });

  test("Task Miner recognizes the repeated flagship traces and recommends GRPO from measured reward variance", async () => withTrainingStore(async ({ store }) => {
    const world = generateCrossSystemWorld({ seed: 53, split: "train", difficulty: "hard" });
    const tasks = generateCrossSystemTasks(world);
    const baseline = await runScriptedCrossSystemBaseline({ worlds: [world], tasks });
    for (let index = 0; index < baseline.trajectories.length; index += 1) {
      const trajectory = baseline.trajectories[index]!;
      const result = baseline.results[index]!;
      await store.upsertTrainingSource({
        ...sourceFixture(`cso_source_${index}`, `cso_world_${index}`),
        title: `Cross-system operation ${index + 1}`,
        metadata: crossSystemTrainingSourceMetadata({ trajectory, result, report: baseline.report, approved: result.outcome === "correct" }),
      });
    }
    const candidates = await createTaskMinerService({ store }).run({ profileId: "default" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      workflowSignature: "cross-system-operations",
      recommendation: { tactic: "grpo_rft", eligible: true, generatedBy: "baseline_reassessment" },
      metadata: { flagship: "cross-system-operations", toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
    });
    expect(Array.isArray(candidates[0]?.metadata.approvedSuccessfulTrajectoryIds)).toBe(true);
    expect(CROSS_SYSTEM_TOOL_NAMES).toEqual(["search_crm", "query_billing", "search_support", "run_python"]);
  }));

  test("Task Miner blocks paid RFT instead of inventing SFT demonstrations when reward variance is zero", async () => withTrainingStore(async ({ store }) => {
    const world = generateCrossSystemWorld({ seed: 54, split: "train", difficulty: "hard" });
    const tasks = generateCrossSystemTasks(world);
    const baseline = await runScriptedCrossSystemBaseline({ worlds: [world], tasks });
    for (let index = 0; index < baseline.trajectories.length; index += 1) {
      const trajectory = baseline.trajectories[index]!;
      const result = baseline.results[index]!;
      const metadata = crossSystemTrainingSourceMetadata({
        trajectory,
        result,
        report: baseline.report,
        approved: false,
      });
      const crossSystemOperations = {
        ...(metadata.crossSystemOperations as Record<string, unknown>),
        outcome: "incorrect",
        reward: 0,
        rewardEligible: true,
        approved: false,
      };
      await store.upsertTrainingSource({
        ...sourceFixture(`cso_zero_source_${index}`, `cso_zero_world_${index}`),
        metadata: { ...metadata, crossSystemOperations },
      });
    }

    const [candidate] = await createTaskMinerService({ store }).run({ profileId: "default" });

    expect(candidate?.recommendation).toMatchObject({
      tactic: "grpo_rft",
      eligible: false,
      generatedBy: "baseline_reassessment",
    });
    expect(candidate?.recommendation.blockers.join(" ")).toContain("zero eligible reward variance");
    expect(candidate?.recommendation.reasons.join(" ")).not.toContain("successful outputs");
  }));

  test("records harness baseline sources with verified structured lineage and split-safe clusters", async () => withTrainingStore(async ({ store }) => {
    const specs = [
      { seed: 71, split: "train" as const, difficulty: "easy" as const },
      { seed: 72, split: "validation" as const, difficulty: "medium" as const },
      { seed: 73, split: "frozen_eval" as const, difficulty: "hard" as const },
    ];
    const sourceIds = Array.from({ length: 15 }, (_, index) => `fixture_baseline_source_${index}`);
    for (const [index, sourceId] of sourceIds.entries()) {
      await store.upsertTrainingSource(sourceFixture(sourceId, `original_cluster_${index}`));
    }
    const recorded = await recordFixtureBaselineSources({
      store,
      profileId: "default",
      sourceIds,
      worldSpecs: specs,
      model: { providerId: "openpond", modelId: "openpond-scripted-chat-two-turns" },
    });
    expect(recorded.report.reward.variance).toBeGreaterThan(0);
    expect(new Set(recorded.sources.map((source) => source.clusterKey)).size).toBe(3);
    expect(recorded.sources.every((source) => source.metadata.fixtureBaseline === true)).toBe(true);
    expect(recorded.sources.filter((source) => (source.metadata.crossSystemOperations as any).approved === true)).toHaveLength(recorded.bootstrap.length);
    expect(recorded.bootstrap.every((record) => record.messages.some((message) => message.role === "tool") && record.messages.some((message) => message.tool_calls?.length))).toBe(true);
  }));

  test("Task Creator freezes the flagship contract, GRPO primary path, generated environment, verifier, and approved-only bootstrap lineage", async () => {
    const suite = generateCrossSystemSuite({ trainSeeds: [61], validationSeeds: [], frozenEvalSeeds: [83], difficulties: ["medium"] });
    const baseline = await runScriptedCrossSystemBaseline({ worlds: suite.worlds, tasks: suite.tasks });
    const taskById = new Map(suite.tasks.map((task) => [task.id, task]));
    const sources = baseline.trajectories.map((trajectory, index) => ({
      ...sourceFixture(`creator_cso_${index}`, `creator_cluster_${index}`),
      metadata: crossSystemTrainingSourceMetadata({ trajectory, result: baseline.results[index]!, report: baseline.report, approved: baseline.results[index]?.outcome === "correct" }),
    }));
    const approvedSource = sources.find((source) => (source.metadata.crossSystemOperations as { approved?: boolean }).approved === true)!;
    const staleSource = structuredClone(approvedSource);
    const staleMetadata = staleSource.metadata.crossSystemOperations as { bootstrapMessages: Array<{ role: string; content?: string | null }> };
    const approvedTrajectoryIds = baseline.trajectories.filter((_, index) => baseline.results[index]?.outcome === "correct").map((trajectory) => trajectory.id);
    staleMetadata.bootstrapMessages = structuredClone(buildCrossSystemBootstrapDataset({
      tasks: suite.tasks,
      trajectories: baseline.trajectories,
      results: baseline.results,
      approvedTrajectoryIds,
      approvedBy: "local_user",
      approvedAt: "2026-07-13T00:00:00.000Z",
    }).find((record) => record.trajectoryId === (staleMetadata as { trajectoryId?: string }).trajectoryId)?.messages ?? []);
    staleMetadata.bootstrapMessages[0] = { role: "system", content: "stale source-side protocol prompt" };
    expect(crossSystemStructuredExample(staleSource)?.inputMessages[0]?.content).toBe(CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT);
    const examples = sources.map((source, index) => {
      const trajectory = baseline.trajectories[index]!;
      const task = taskById.get(trajectory.taskId)!;
      const result = baseline.results[index]!;
      return {
        id: `creator_example_${index}`,
        sourceId: source.id,
        sourceTurnId: null,
        split: task.split,
        origin: "corrected" as const,
        inputPrompt: task.prompt,
        expectedOutputText: result.outcome === "correct" ? `ANSWER: ${JSON.stringify(task.expectedAnswer)}` : "ANSWER: {}",
        rationale: "Synthetic baseline trajectory with frozen verifier evidence.",
      };
    });
    const proposal = TaskDesignProposalSchema.parse({
      schemaVersion: "openpond.taskDesignProposal.v1",
      id: "creator_cross_system",
      name: "Cross-System Operations Policy",
      objective: "Answer exact cross-system operational questions.",
      diagnosis: { schemaVersion: "openpond.capabilityDiagnosis.v1", summary: "Learn the repeated workflow.", stableBehavior: ["Reconcile systems."], changingKnowledge: [], requiredContext: [], requiredTools: [], intervention: "sft", trainingEligible: true, rationale: ["Repeated traces exist."], confidence: 0.7 },
      taskKind: "chat",
      sourceIds: sources.map((source) => source.id),
      assumptions: [],
      successCriteria: ["Match the exact answer."],
      proposedGraders: [{ id: "old", version: "1", label: "Old", kind: "state", weight: 1, hardGate: true, rewardEligible: true, privileged: true, config: { fields: ["text"] }, metadata: {} }],
      graderFixtures: [],
      generatedFiles: [],
      proposedExamples: examples,
      proposedMethod: "sft",
      policy: { policyVisibleFields: ["input.prompt"], privilegedFields: ["expectedOutput.text"], hiddenGraderRefs: [], connectedAppScopes: [] },
      warnings: [
        "The evidence explicitly exposes only three tool names, so the exact fourth tool schema is missing.",
        "The executable generator and verifier were not included as file contents; generatedFiles is therefore empty and materialization must import and hash-check those existing artifacts.",
        "Keep this independent-world warning.",
      ],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const enriched = enrichCrossSystemProposal(proposal, sources);
    expect(enriched).toMatchObject({ proposedMethod: "grpo", taskKind: "single_agent", diagnosis: { intervention: "grpo_rft", requiredTools: CROSS_SYSTEM_TOOL_NAMES } });
    expect(enriched.proposedExamples).toHaveLength(sources.length);
    expect(enriched.proposedExamples.filter((example) => example.expectedOutputText)).toHaveLength(
      baseline.results.filter((result) => result.outcome === "correct").length,
    );
    expect(enriched.generatedFiles.map((file) => file.path)).toEqual(expect.arrayContaining(["environment/taskset.ts", "environment/tool-contract.json", "environment/worlds.json", "environment/tasks.json", "graders/cross-system-verifier.ts", "fixtures/adversarial.json"]));
    expect(enriched.generatedFiles.every((file) => file.content.includes(CROSS_SYSTEM_TOOL_CONTRACT_HASH) || ["environment/worlds.json", "environment/tasks.json"].includes(file.path))).toBe(true);
    expect(enriched.warnings).toContain("Keep this independent-world warning.");
    expect(enriched.warnings.some((warning) => warning.includes("fourth tool") || warning.includes("generatedFiles is therefore empty"))).toBe(false);

    const zeroRewardSources = sources.map((source) => {
      const crossSystemOperations = {
        ...(source.metadata.crossSystemOperations as Record<string, unknown>),
        outcome: "incorrect",
        reward: 0,
        rewardEligible: true,
        approved: false,
        bootstrapMessages: null,
      };
      return {
        ...source,
        metadata: { ...source.metadata, crossSystemOperations },
      };
    });
    const zeroReward = enrichCrossSystemProposal(proposal, zeroRewardSources);
    expect(zeroReward.proposedExamples).toHaveLength(zeroRewardSources.length);
    expect(zeroReward.proposedExamples.every((example) => example.expectedOutputText === null)).toBe(true);
    expect(zeroReward.warnings.join(" ")).toContain("failed policy outputs remain excluded");
  });
});
