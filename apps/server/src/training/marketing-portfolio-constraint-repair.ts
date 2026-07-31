import { contentHash } from "@openpond/taskset-sdk";

const CHANNEL_IDS = [
  "paid_search",
  "paid_social",
  "streaming_video",
  "lifecycle",
] as const;

type ChannelId = (typeof CHANNEL_IDS)[number];
type ChannelLimit = {
  channelId: ChannelId;
  minimumUsd: number;
  maximumUsd: number;
};

export const MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT =
  "You are the marketing portfolio policy under evaluation. " +
  "Call get_portfolio_snapshot first and reason only from that observation. " +
  "Then call submit_budget_decision with a complete allocation, substantive rationale, " +
  "and every applicable explicit risk control. Never invent an episode identifier. " +
  "The four amountUsd values must total incrementalBudgetUsd exactly, use the declared " +
  "allocationIncrementUsd, and stay within every channel minimum and maximum. " +
  "Verify the total before submitting. If public validation rejects a decision, follow " +
  "the supplied public-constraint repair exactly.";

export const MARKETING_PORTFOLIO_HARNESS_CONTRACT = {
  schemaVersion: "openpond.marketingPortfolioPolicyHarness.v3",
  actionOrder: ["get_portfolio_snapshot", "submit_budget_decision"],
  toolChoice: "ordered-required-action.v1",
  maximumTurns: 8,
  systemPromptHash: contentHash(MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT),
  constraintRepair:
    "submitted-preference-public-feasibility-projection-resubmission.v2",
  hiddenRewardInputsAllowed: false,
} as const;

export function projectPubliclyFeasibleAllocation(input: {
  snapshot: Record<string, unknown>;
  decision: Record<string, unknown>;
}): {
  allocations: Array<{ channelId: ChannelId; amountUsd: number }>;
  incrementalBudgetUsd: number;
  allocationIncrementUsd: number;
  allocationTotalUsd: number;
} | null {
  const budget = positiveInteger(input.snapshot.incrementalBudgetUsd);
  const increment = positiveInteger(input.snapshot.allocationIncrementUsd);
  const limits = parseLimits(input.snapshot.channelLimits, increment);
  if (budget === null || increment === null || limits === null) return null;
  const minimum = limits.reduce((sum, item) => sum + item.minimumUsd, 0);
  const maximum = limits.reduce((sum, item) => sum + item.maximumUsd, 0);
  if (
    budget < minimum ||
    budget > maximum ||
    (budget - minimum) % increment !== 0
  ) {
    return null;
  }
  const requested = requestedAmounts(input.decision.allocations);
  const values = new Map<ChannelId, number>();
  for (const limit of limits) {
    const raw = requested.get(limit.channelId) ?? limit.minimumUsd;
    values.set(
      limit.channelId,
      clamp(
        Math.round(raw / increment) * increment,
        limit.minimumUsd,
        limit.maximumUsd,
      ),
    );
  }
  let total = [...values.values()].reduce((sum, value) => sum + value, 0);
  while (total < budget) {
    const candidate = limits
      .filter(
        (limit) =>
          (values.get(limit.channelId) ?? limit.minimumUsd) + increment <=
          limit.maximumUsd,
      )
      .sort((left, right) => {
        const leftGap =
          (requested.get(left.channelId) ?? left.minimumUsd) -
          (values.get(left.channelId) ?? left.minimumUsd);
        const rightGap =
          (requested.get(right.channelId) ?? right.minimumUsd) -
          (values.get(right.channelId) ?? right.minimumUsd);
        return rightGap - leftGap;
      })[0];
    if (!candidate) return null;
    values.set(candidate.channelId, values.get(candidate.channelId)! + increment);
    total += increment;
  }
  while (total > budget) {
    const candidate = limits
      .filter(
        (limit) =>
          (values.get(limit.channelId) ?? limit.minimumUsd) - increment >=
          limit.minimumUsd,
      )
      .sort((left, right) => {
        const leftExcess =
          (values.get(left.channelId) ?? left.minimumUsd) -
          (requested.get(left.channelId) ?? left.minimumUsd);
        const rightExcess =
          (values.get(right.channelId) ?? right.minimumUsd) -
          (requested.get(right.channelId) ?? right.minimumUsd);
        return rightExcess - leftExcess;
      })[0];
    if (!candidate) return null;
    values.set(candidate.channelId, values.get(candidate.channelId)! - increment);
    total -= increment;
  }
  const allocations = CHANNEL_IDS.map((channelId) => ({
    channelId,
    amountUsd: values.get(channelId)!,
  }));
  return {
    allocations,
    incrementalBudgetUsd: budget,
    allocationIncrementUsd: increment,
    allocationTotalUsd: allocations.reduce(
      (sum, allocation) => sum + allocation.amountUsd,
      0,
    ),
  };
}

function parseLimits(value: unknown, increment: number | null): ChannelLimit[] | null {
  if (!Array.isArray(value) || increment === null) return null;
  const result = new Map<ChannelId, ChannelLimit>();
  for (const item of value) {
    if (!record(item)) return null;
    const channelId = CHANNEL_IDS.find((candidate) => candidate === item.channelId);
    const minimumUsd = nonnegativeInteger(item.minimumUsd);
    const maximumUsd = nonnegativeInteger(item.maximumUsd);
    if (
      !channelId ||
      minimumUsd === null ||
      maximumUsd === null ||
      minimumUsd > maximumUsd ||
      minimumUsd % increment !== 0 ||
      maximumUsd % increment !== 0 ||
      result.has(channelId)
    ) {
      return null;
    }
    result.set(channelId, { channelId, minimumUsd, maximumUsd });
  }
  return result.size === CHANNEL_IDS.length
    ? CHANNEL_IDS.map((channelId) => result.get(channelId)!)
    : null;
}

function requestedAmounts(value: unknown): Map<ChannelId, number> {
  const result = new Map<ChannelId, number>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!record(item)) continue;
    const channelId = CHANNEL_IDS.find((candidate) => candidate === item.channelId);
    const amount =
      typeof item.amountUsd === "number" &&
      Number.isFinite(item.amountUsd) &&
      item.amountUsd >= 0
        ? item.amountUsd
        : null;
    if (channelId && amount !== null && !result.has(channelId)) {
      result.set(channelId, amount);
    }
  }
  return result;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
