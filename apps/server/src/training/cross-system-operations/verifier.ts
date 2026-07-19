import {
  CrossSystemTrajectorySchema,
  CrossSystemVerifierResultSchema,
  type CrossSystemTrajectory,
  type CrossSystemVerifierResult,
} from "@openpond/contracts";
import type { CrossSystemTask } from "./types.js";

const UNORDERED_ARRAY_KEYS = new Set(["account_ids", "matches", "violations", "mismatches"]);

export function verifyCrossSystemTrajectory(input: {
  task: CrossSystemTask;
  trajectory: CrossSystemTrajectory;
}): CrossSystemVerifierResult {
  const trajectory = CrossSystemTrajectorySchema.parse(input.trajectory);
  const metrics = trajectoryMetrics(trajectory);
  const infrastructure = trajectory.status === "infrastructure_failure" || Boolean(trajectory.infrastructureError);
  const schemaViolation = trajectory.steps.some((step) => step.kind === "tool_result" && !step.ok && /schema|cursor|unknown tool/i.test(step.error ?? ""));
  const final = [...trajectory.steps].reverse().find((step) => step.kind === "final");
  const parsed = final ? parseAnswer(final.content) : { ok: false as const, value: null, error: "Trajectory has no final ANSWER envelope." };
  const exact = parsed.ok && crossSystemAnswersEqual(parsed.value, input.task.expectedAnswer);
  let outcome: CrossSystemVerifierResult["outcome"];
  if (infrastructure) outcome = "infrastructure_failure";
  else if (trajectory.status === "cancelled") outcome = "cancelled";
  else if (trajectory.status === "budget_exhausted") outcome = "budget_exhausted";
  else if (schemaViolation) outcome = "tool_schema_violation";
  else if (!parsed.ok) outcome = "parse_failure";
  else outcome = exact ? "correct" : "incorrect";

  const nonPolicyOutcome = ["infrastructure_failure", "cancelled", "budget_exhausted", "tool_schema_violation"].includes(outcome);
  const efficiency = exact ? efficiencyReward(input.task, metrics) : 0;
  const conciseOutput = exact && final ? concisionReward(final.content, input.task.expectedAnswer) : 0;
  const reward = nonPolicyOutcome ? null : round(exact ? 1 + efficiency + conciseOutput : 0);
  return CrossSystemVerifierResultSchema.parse({
    schemaVersion: "openpond.crossSystemOperations.v1",
    trajectoryId: trajectory.id,
    outcome,
    reward,
    rewardEligible: !nonPolicyOutcome,
    exactAnswer: exact,
    components: { exactAnswer: exact ? 1 : 0, efficiency, conciseOutput },
    metrics: { ...metrics, parseFailures: parsed.ok ? 0 : 1, budgetExhausted: trajectory.status === "budget_exhausted" },
    parsedAnswer: parsed.ok ? parsed.value : null,
    feedback: feedbackFor(outcome, parsed.ok ? null : parsed.error),
  });
}

export function parseCrossSystemAnswer(content: string): unknown {
  const parsed = parseAnswer(content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export function crossSystemAnswersEqual(left: unknown, right: unknown): boolean {
  return deepEqual(normalizeAnswer(left), normalizeAnswer(right));
}

function parseAnswer(content: string): { ok: true; value: unknown } | { ok: false; value: null; error: string } {
  const match = /^\s*ANSWER:\s*([^]*?)\s*$/.exec(content);
  if (!match) return { ok: false, value: null, error: "Final output must use ANSWER: followed by JSON." };
  try {
    const value = JSON.parse(match[1] ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, value: null, error: "ANSWER value must be a JSON object." };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : "ANSWER JSON is invalid." };
  }
}

function trajectoryMetrics(trajectory: CrossSystemTrajectory) {
  const results = trajectory.steps.filter((step) => step.kind === "tool_result");
  let consecutive = 0;
  let current = 0;
  for (const step of trajectory.steps) {
    if (step.kind === "tool_call" && step.name !== "run_python") {
      current += 1;
      consecutive = Math.max(consecutive, current);
    } else if (step.kind === "model" || step.kind === "final") current = 0;
  }
  return {
    toolCalls: trajectory.steps.filter((step) => step.kind === "tool_call").length,
    rowsRead: results.reduce((sum, step) => sum + step.rows, 0),
    bytesRead: results.reduce((sum, step) => sum + step.bytes, 0),
    consecutiveRetrievalCalls: consecutive,
    wallTimeMs: Math.max(0, Date.parse(trajectory.completedAt) - Date.parse(trajectory.startedAt)),
  };
}

function efficiencyReward(task: CrossSystemTask, metrics: ReturnType<typeof trajectoryMetrics>): number {
  const idealCalls = Math.max(1, task.queryPlan.length);
  const callPenalty = Math.min(1, Math.max(0, metrics.toolCalls - idealCalls) / Math.max(1, task.budget.maxTurns - idealCalls));
  const rowRatio = Math.min(1, metrics.rowsRead / task.budget.maxRows);
  const byteRatio = Math.min(1, metrics.bytesRead / task.budget.maxBytes);
  const timeRatio = Math.min(1, metrics.wallTimeMs / 120_000);
  const score = 1 - (callPenalty * 0.45 + rowRatio * 0.25 + byteRatio * 0.2 + timeRatio * 0.1);
  return round(Math.max(0, score) * 0.1);
}

function concisionReward(content: string, expected: Record<string, unknown>): number {
  const ideal = Buffer.byteLength(`ANSWER: ${JSON.stringify(expected)}`, "utf8");
  const actual = Buffer.byteLength(content.trim(), "utf8");
  if (actual <= ideal + 8) return 0.05;
  if (actual <= ideal + 64) return 0.025;
  return 0;
}

function normalizeAnswer(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeAnswer(item));
    return UNORDERED_ARRAY_KEYS.has(parentKey)
      ? normalized.sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      : normalized;
  }
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeAnswer(item, key)]));
  }
  return typeof value === "string" ? value.normalize("NFC").trim() : value;
}

function feedbackFor(outcome: CrossSystemVerifierResult["outcome"], parseError: string | null): string[] {
  if (outcome === "correct") return ["Exact normalized answer matched the frozen ground truth."];
  if (outcome === "incorrect") return ["The parsed answer did not exactly match the frozen ground truth."];
  if (outcome === "parse_failure") return [parseError ?? "The final answer envelope could not be parsed."];
  if (outcome === "budget_exhausted") return ["The bounded rollout budget was exhausted before a valid final answer."];
  if (outcome === "tool_schema_violation") return ["A tool call violated the versioned registered schema."];
  if (outcome === "cancelled") return ["The rollout was cancelled; no reward was produced."];
  return ["Infrastructure failed; the attempt is excluded from reward."];
}

function deepEqual(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right); }
function stableJson(value: unknown): string { return JSON.stringify(value); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
