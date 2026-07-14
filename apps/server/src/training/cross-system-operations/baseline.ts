import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CrossSystemTrajectorySchema,
  type CrossSystemTrajectory,
  type CrossSystemTrajectoryStep,
  type CrossSystemVerifierResult,
} from "@openpond/contracts";
import { CrossSystemEnvironment } from "./environment.js";
import type { CrossSystemTask, CrossSystemTaskFamily, CrossSystemWorld } from "./types.js";
import { verifyCrossSystemTrajectory } from "./verifier.js";

export type CrossSystemBaselineReport = {
  schemaVersion: "openpond.crossSystemOperations.v1";
  id: string;
  toolContractHash: string;
  model: { providerId: string; modelId: string };
  trajectoryIds: string[];
  exactMatchAccuracy: number;
  successByFamily: Record<CrossSystemTaskFamily, { attempts: number; correct: number }>;
  successByDifficulty: Record<"easy" | "medium" | "hard", { attempts: number; correct: number }>;
  metrics: { toolCalls: number; rowsRead: number; bytesRead: number; wallTimeMs: number; parseFailures: number; budgetExhaustion: number };
  reward: { count: number; mean: number; min: number; max: number; variance: number };
};

export function crossSystemTrainingSourceMetadata(input: {
  trajectory: CrossSystemTrajectory;
  result: CrossSystemVerifierResult;
  report: CrossSystemBaselineReport;
  approved: boolean;
}): Record<string, unknown> {
  if (input.trajectory.toolContractHash !== input.report.toolContractHash) throw new Error("Baseline/source tool contract lineage mismatch.");
  return {
    workflowSignature: "cross-system-operations",
    verifiableOutcome: true,
    frontierCost: true,
    agentAction: true,
    confidence: 0.98,
    crossSystemOperations: {
      schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
      trajectoryId: input.trajectory.id,
      taskId: input.trajectory.taskId,
      worldId: input.trajectory.worldId,
      toolContractHash: input.trajectory.toolContractHash,
      outcome: input.result.outcome,
      reward: input.result.reward,
      rewardEligible: input.result.rewardEligible,
      approved: input.approved && input.result.outcome === "correct",
      baselineId: input.report.id,
      worldSeed: input.trajectory.metadata.worldSeed,
      worldSplit: input.trajectory.metadata.worldSplit,
      worldDifficulty: input.trajectory.metadata.worldDifficulty,
    },
  };
}

export async function runScriptedCrossSystemBaseline(input: {
  worlds: CrossSystemWorld[];
  tasks: CrossSystemTask[];
  model?: { providerId: string; modelId: string };
}): Promise<{ report: CrossSystemBaselineReport; trajectories: CrossSystemTrajectory[]; results: CrossSystemVerifierResult[] }> {
  const model = input.model ?? { providerId: "openpond", modelId: "scripted-frontier-baseline" };
  const worldById = new Map(input.worlds.map((world) => [world.id, world]));
  const selectedTasks = input.tasks.filter((task) => task.phrasingVariant === 0);
  const trajectories: CrossSystemTrajectory[] = [];
  const results: CrossSystemVerifierResult[] = [];
  for (let index = 0; index < selectedTasks.length; index += 1) {
    const task = selectedTasks[index]!;
    const world = worldById.get(task.worldId);
    if (!world) throw new Error(`Missing world ${task.worldId}.`);
    const variant = index % 3 === 0 ? "correct" : index % 3 === 1 ? "incorrect" : "inefficient";
    const trajectory = await scriptedTrajectory({ world, task, model, variant, ordinal: index });
    trajectories.push(trajectory);
    results.push(verifyCrossSystemTrajectory({ task, trajectory }));
  }
  const report = buildCrossSystemBaselineReport({
    id: `cso_baseline_${input.worlds.map((world) => world.id).join("_").slice(-100)}`,
    model,
    tasks: selectedTasks,
    trajectories,
    results,
  });
  if (!(report.reward.variance > 0) || report.reward.min === report.reward.max) throw new Error("Scripted frontier baseline must exhibit reward variance.");
  return { report, trajectories, results };
}

export function buildCrossSystemBaselineReport(input: {
  id: string;
  model: { providerId: string; modelId: string };
  tasks: CrossSystemTask[];
  trajectories: CrossSystemTrajectory[];
  results: CrossSystemVerifierResult[];
}): CrossSystemBaselineReport {
  if (input.tasks.length !== input.trajectories.length || input.tasks.length !== input.results.length) {
    throw new Error("Cross-system baseline tasks, trajectories, and verifier results must align.");
  }
  const eligibleRewards = input.results.map((result) => result.reward).filter((reward): reward is number => reward !== null);
  const mean = eligibleRewards.reduce((sum, reward) => sum + reward, 0) / Math.max(1, eligibleRewards.length);
  return {
    schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
    id: input.id,
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    model: input.model,
    trajectoryIds: input.trajectories.map((trajectory) => trajectory.id),
    exactMatchAccuracy: input.results.filter((result) => result.exactAnswer).length / Math.max(1, input.results.length),
    successByFamily: summarize(input.tasks, input.results, (task) => task.family),
    successByDifficulty: summarize(input.tasks, input.results, (task) => task.difficulty),
    metrics: {
      toolCalls: sum(input.results, (result) => result.metrics.toolCalls),
      rowsRead: sum(input.results, (result) => result.metrics.rowsRead),
      bytesRead: sum(input.results, (result) => result.metrics.bytesRead),
      wallTimeMs: sum(input.results, (result) => result.metrics.wallTimeMs),
      parseFailures: sum(input.results, (result) => result.metrics.parseFailures),
      budgetExhaustion: input.results.filter((result) => result.metrics.budgetExhausted).length,
    },
    reward: {
      count: eligibleRewards.length,
      mean,
      min: eligibleRewards.length ? Math.min(...eligibleRewards) : 0,
      max: eligibleRewards.length ? Math.max(...eligibleRewards) : 0,
      variance: eligibleRewards.reduce((total, reward) => total + (reward - mean) ** 2, 0) / Math.max(1, eligibleRewards.length),
    },
  };
}

async function scriptedTrajectory(input: {
  world: CrossSystemWorld;
  task: CrossSystemTask;
  model: { providerId: string; modelId: string };
  variant: "correct" | "incorrect" | "inefficient";
  ordinal: number;
}): Promise<CrossSystemTrajectory> {
  const id = `cso_trace_${input.task.id}_${input.variant}`;
  const environment = new CrossSystemEnvironment({ attemptId: id, world: input.world, task: input.task });
  const steps: CrossSystemTrajectoryStep[] = [{ kind: "model", turn: 0, content: "I will reconcile the bounded synthetic systems before answering." }];
  let turn = 1;
  const calls = toolCallsFor(input.task, input.world);
  const scheduled = input.variant === "inefficient" ? [calls[0]!, calls[0]!, calls[0]!, ...calls] : calls;
  try {
    for (const call of scheduled) {
      const callId = `call_${turn}_${call.name}`;
      steps.push({ kind: "tool_call", turn, callId, name: call.name, arguments: call.arguments });
      try {
        const result = await environment.execute(call.name, call.arguments);
        const evidence = environment.evidence.at(-1)!;
        steps.push({ kind: "tool_result", turn, callId, name: call.name, ok: true, result, rows: evidence.rows, bytes: evidence.bytes, durationMs: evidence.durationMs, error: null });
      } catch (error) {
        const evidence = environment.evidence.at(-1);
        steps.push({ kind: "tool_result", turn, callId, name: call.name, ok: false, result: null, rows: evidence?.rows ?? 0, bytes: evidence?.bytes ?? 0, durationMs: evidence?.durationMs ?? 0, error: error instanceof Error ? error.message : String(error) });
      }
      turn += 1;
    }
  } finally {
    await environment.close();
  }
  const answer = input.variant === "incorrect" ? {} : input.task.expectedAnswer;
  steps.push({ kind: "final", turn, content: `ANSWER: ${JSON.stringify(answer)}` });
  const startedAt = new Date(Date.UTC(2026, 6, 13, 0, input.ordinal, 0)).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + (input.variant === "inefficient" ? 9_000 : 3_000)).toISOString();
  return CrossSystemTrajectorySchema.parse({
    schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
    id,
    worldId: input.world.id,
    taskId: input.task.id,
    toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    modelRef: input.model,
    status: "completed",
    steps,
    startedAt,
    completedAt,
    infrastructureError: null,
    metadata: {
      baseline: "frontier",
      scriptedOutcome: input.variant,
      approved: input.variant !== "incorrect",
      worldSeed: input.world.seed,
      worldSplit: input.world.split,
      worldDifficulty: input.world.difficulty,
    },
  });
}

function toolCallsFor(task: CrossSystemTask, world: CrossSystemWorld): Array<{ name: "search_crm" | "query_billing" | "search_support" | "run_python"; arguments: Record<string, unknown> }> {
  const accountIds = world.accounts.map((account) => account.accountId);
  return task.queryPlan.map(({ tool }) => {
    if (tool === "search_crm") return { name: tool, arguments: { query: "*", fields: ["account_id", "name", "aliases", "contract_value_usd_cents", "renewal_date", "tier", "active_contract_id", "contract_term_months"], cursor: null, limit: 50 } };
    if (tool === "query_billing") return { name: tool, arguments: { account_ids: accountIds, date_range: { from: "2025-01-01", to: "2027-12-31" }, status: ["open", "overdue", "paid", "disputed", "scheduled", "void"], cursor: null, limit: 50 } };
    if (tool === "search_support") return { name: tool, arguments: { account_ids: accountIds, severity: ["P1", "P2", "P3", "P4"], state: ["new", "investigating", "waiting_customer", "resolved", "closed"], cursor: null, limit: 50 } };
    return { name: tool, arguments: { code: "values = [1, 2, 3]\n_result = sum(values)" } };
  });
}

function summarize<TKey extends string>(tasks: CrossSystemTask[], results: CrossSystemVerifierResult[], key: (task: CrossSystemTask) => TKey): Record<TKey, { attempts: number; correct: number }> {
  const output = {} as Record<TKey, { attempts: number; correct: number }>;
  tasks.forEach((task, index) => {
    const name = key(task);
    output[name] ??= { attempts: 0, correct: 0 };
    output[name].attempts += 1;
    if (results[index]?.exactAnswer) output[name].correct += 1;
  });
  return output;
}

function sum(items: CrossSystemVerifierResult[], select: (item: CrossSystemVerifierResult) => number): number { return items.reduce((total, item) => total + select(item), 0); }
