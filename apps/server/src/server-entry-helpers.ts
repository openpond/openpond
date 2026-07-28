import type { RuntimeEvent } from "@openpond/contracts";

const DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS = 64;

export function parseModelJudgeResult(
  raw: string
): {
  score: number;
  passed: boolean;
  feedback: string;
  evidenceRefs: string[];
} | null {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    const value = JSON.parse(normalized) as Record<string, unknown>;
    if (typeof value.score !== "number" || typeof value.passed !== "boolean")
      return null;
    return {
      score: Math.max(0, Math.min(1, value.score)),
      passed: value.passed,
      feedback:
        typeof value.feedback === "string"
          ? value.feedback.slice(0, 20_000)
          : "Model judge completed.",
      evidenceRefs: [],
    };
  } catch {
    return null;
  }
}

export function resolveMaxHostedWorkspaceToolRounds(
  optionValue: number | undefined
): number {
  if (
    typeof optionValue === "number" &&
    Number.isFinite(optionValue) &&
    optionValue > 0
  ) {
    return Math.floor(optionValue);
  }
  const envValue = process.env.OPENPOND_HOSTED_WORKSPACE_TOOL_ROUNDS?.trim();
  if (!envValue) return DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS;
  if (/^(unlimited|infinite|infinity)$/i.test(envValue))
    return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_HOSTED_WORKSPACE_TOOL_ROUNDS;
}

export function findRecentCodexCompactionCompleted(
  events: RuntimeEvent[],
  sessionId: string,
  codexThreadId: string
): RuntimeEvent | null {
  const cutoff = Date.now() - 60_000;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    const timestamp = Date.parse(item.timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoff) return null;
    if (
      item.sessionId !== sessionId ||
      item.name !== "session.compaction.completed"
    )
      continue;
    const data =
      item.data && typeof item.data === "object"
        ? (item.data as Record<string, unknown>)
        : null;
    if (data?.provider === "codex" && data.codexThreadId === codexThreadId)
      return item;
  }
  return null;
}

export function createImproveTargetKind(
  value: string | null
): "agent" | "skill" | "extension" | "model" | "configuration" | null {
  return value === "agent" ||
    value === "skill" ||
    value === "extension" ||
    value === "model" ||
    value === "configuration"
    ? value
    : null;
}

export function createImproveLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}
