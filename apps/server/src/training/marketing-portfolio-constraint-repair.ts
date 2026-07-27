import { contentHash } from "@openpond/taskset-sdk";

const PORTFOLIO_CHANNEL_IDS = [
  "paid_search",
  "paid_social",
  "streaming_video",
  "lifecycle",
] as const;

export const MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT =
  "You are the marketing portfolio policy under evaluation. "
  + "You must call get_portfolio_snapshot first, reason from only that observation, "
  + "then call submit_budget_decision with a complete allocation, a substantive rationale, "
  + "and every applicable explicit risk control. Never invent an episode identifier; "
  + "the Harness binds private episode state to your tool calls. "
  + "The four amountUsd values are shares of one incremental budget: together they must "
  + "equal incrementalBudgetUsd exactly, each must use allocationIncrementUsd increments, "
  + "and each must stay inside that channel's minimumUsd and maximumUsd. "
  + "Solve feasibility before optimization: start every channel at its minimumUsd, sum "
  + "those four minima, then distribute the remaining budget in allocationIncrementUsd "
  + "steps without crossing any maximumUsd. Verify the four final amounts sum to "
  + "incrementalBudgetUsd before submitting. "
  + "Never assign the full incrementalBudgetUsd to every channel. If the public validator "
  + "rejects a decision, use its public-constraint-only projection exactly before making "
  + "any further optional changes.";

export const MARKETING_PORTFOLIO_HARNESS_CONTRACT = {
  schemaVersion: "openpond.marketingPortfolioPolicyHarness.v3",
  actionOrder: [
    "get_portfolio_snapshot",
    "submit_budget_decision",
  ],
  toolChoice: "ordered-required-action.v1",
  maximumTurns: 8,
  systemPromptHash: contentHash(MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT),
  constraintRepair:
    "submitted-preference-public-feasibility-projection-resubmission.v2",
  constraintRepairInputs: [
    "incrementalBudgetUsd",
    "allocationIncrementUsd",
    "channelLimits",
    "submittedAllocations",
  ],
  constraintRepairApplication:
    "after-rejection-next-policy-resubmission-allocation-normalization",
  rawAndExecutedArgumentsRetained: true,
  hiddenRewardInputsAllowed: false,
} as const;

export const MARKETING_PORTFOLIO_HARNESS_CONTRACT_HASH = contentHash(
  MARKETING_PORTFOLIO_HARNESS_CONTRACT,
);

type PortfolioChannelId = (typeof PORTFOLIO_CHANNEL_IDS)[number];

type ChannelLimit = {
  channelId: PortfolioChannelId;
  minimumUsd: number;
  maximumUsd: number;
};

export type PublicAllocationProjection = {
  allocations: Array<{
    channelId: PortfolioChannelId;
    amountUsd: number;
  }>;
  incrementalBudgetUsd: number;
  allocationIncrementUsd: number;
  allocationTotalUsd: number;
};

/**
 * Projects a policy's last allocation onto the public feasibility constraints.
 *
 * This deliberately uses no scorer state, hidden response curves, or optimal
 * allocation. It gives small policies an exact arithmetic repair while
 * preserving their submitted channel preference as far as the constraints
 * allow.
 */
export function projectPubliclyFeasibleAllocation(input: {
  snapshot: Record<string, unknown>;
  decision: Record<string, unknown>;
}): PublicAllocationProjection | null {
  const incrementalBudgetUsd = positiveInteger(
    input.snapshot.incrementalBudgetUsd,
  );
  const allocationIncrementUsd = positiveInteger(
    input.snapshot.allocationIncrementUsd,
  );
  const channelLimits = parseChannelLimits(
    input.snapshot.channelLimits,
    allocationIncrementUsd,
  );
  if (
    incrementalBudgetUsd === null
    || allocationIncrementUsd === null
    || channelLimits === null
  ) {
    return null;
  }
  const minimumTotal = channelLimits.reduce(
    (sum, limit) => sum + limit.minimumUsd,
    0,
  );
  const maximumTotal = channelLimits.reduce(
    (sum, limit) => sum + limit.maximumUsd,
    0,
  );
  if (
    incrementalBudgetUsd < minimumTotal
    || incrementalBudgetUsd > maximumTotal
    || (incrementalBudgetUsd - minimumTotal) % allocationIncrementUsd !== 0
  ) {
    return null;
  }

  const requested = requestedAmounts(input.decision.allocations);
  const values = new Map<PortfolioChannelId, number>();
  for (const limit of channelLimits) {
    const raw = requested.get(limit.channelId) ?? limit.minimumUsd;
    values.set(
      limit.channelId,
      clamp(
        roundToIncrement(raw, allocationIncrementUsd),
        limit.minimumUsd,
        limit.maximumUsd,
      ),
    );
  }

  let total = totalFor(values);
  while (total < incrementalBudgetUsd) {
    const candidate = channelLimits
      .filter(
        (limit) =>
          (values.get(limit.channelId) ?? limit.minimumUsd)
            + allocationIncrementUsd
          <= limit.maximumUsd,
      )
      .sort((left, right) =>
        compareIncreaseCandidate(left, right, values, requested)
      )[0];
    if (!candidate) return null;
    values.set(
      candidate.channelId,
      (values.get(candidate.channelId) ?? candidate.minimumUsd)
        + allocationIncrementUsd,
    );
    total += allocationIncrementUsd;
  }
  while (total > incrementalBudgetUsd) {
    const candidate = channelLimits
      .filter(
        (limit) =>
          (values.get(limit.channelId) ?? limit.minimumUsd)
            - allocationIncrementUsd
          >= limit.minimumUsd,
      )
      .sort((left, right) =>
        compareDecreaseCandidate(left, right, values, requested)
      )[0];
    if (!candidate) return null;
    values.set(
      candidate.channelId,
      (values.get(candidate.channelId) ?? candidate.minimumUsd)
        - allocationIncrementUsd,
    );
    total -= allocationIncrementUsd;
  }

  const allocations = PORTFOLIO_CHANNEL_IDS.map((channelId) => ({
    channelId,
    amountUsd: values.get(channelId)!,
  }));
  return {
    allocations,
    incrementalBudgetUsd,
    allocationIncrementUsd,
    allocationTotalUsd: allocations.reduce(
      (sum, allocation) => sum + allocation.amountUsd,
      0,
    ),
  };
}

function parseChannelLimits(
  value: unknown,
  increment: number | null,
): ChannelLimit[] | null {
  if (!Array.isArray(value) || increment === null) return null;
  const byChannel = new Map<PortfolioChannelId, ChannelLimit>();
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const channelId = PORTFOLIO_CHANNEL_IDS.find(
      (id) => id === candidate.channelId,
    );
    const minimumUsd = nonnegativeInteger(candidate.minimumUsd);
    const maximumUsd = nonnegativeInteger(candidate.maximumUsd);
    if (
      !channelId
      || minimumUsd === null
      || maximumUsd === null
      || minimumUsd > maximumUsd
      || minimumUsd % increment !== 0
      || maximumUsd % increment !== 0
      || byChannel.has(channelId)
    ) {
      return null;
    }
    byChannel.set(channelId, {
      channelId,
      minimumUsd,
      maximumUsd,
    });
  }
  if (byChannel.size !== PORTFOLIO_CHANNEL_IDS.length) return null;
  return PORTFOLIO_CHANNEL_IDS.map((channelId) => byChannel.get(channelId)!);
}

function requestedAmounts(
  value: unknown,
): Map<PortfolioChannelId, number> {
  const result = new Map<PortfolioChannelId, number>();
  if (!Array.isArray(value)) return result;
  for (const allocation of value) {
    if (!isRecord(allocation)) continue;
    const channelId = PORTFOLIO_CHANNEL_IDS.find(
      (id) => id === allocation.channelId,
    );
    const amountUsd =
      typeof allocation.amountUsd === "number"
      && Number.isFinite(allocation.amountUsd)
      && allocation.amountUsd >= 0
        ? allocation.amountUsd
        : null;
    if (channelId && amountUsd !== null && !result.has(channelId)) {
      result.set(channelId, amountUsd);
    }
  }
  return result;
}

function compareIncreaseCandidate(
  left: ChannelLimit,
  right: ChannelLimit,
  values: Map<PortfolioChannelId, number>,
  requested: Map<PortfolioChannelId, number>,
): number {
  const leftGap =
    (requested.get(left.channelId) ?? left.minimumUsd)
    - (values.get(left.channelId) ?? left.minimumUsd);
  const rightGap =
    (requested.get(right.channelId) ?? right.minimumUsd)
    - (values.get(right.channelId) ?? right.minimumUsd);
  if (leftGap !== rightGap) return rightGap - leftGap;
  const leftCapacity =
    left.maximumUsd - (values.get(left.channelId) ?? left.minimumUsd);
  const rightCapacity =
    right.maximumUsd - (values.get(right.channelId) ?? right.minimumUsd);
  if (leftCapacity !== rightCapacity) return rightCapacity - leftCapacity;
  return channelIndex(left.channelId) - channelIndex(right.channelId);
}

function compareDecreaseCandidate(
  left: ChannelLimit,
  right: ChannelLimit,
  values: Map<PortfolioChannelId, number>,
  requested: Map<PortfolioChannelId, number>,
): number {
  const leftExcess =
    (values.get(left.channelId) ?? left.minimumUsd)
    - (requested.get(left.channelId) ?? left.minimumUsd);
  const rightExcess =
    (values.get(right.channelId) ?? right.minimumUsd)
    - (requested.get(right.channelId) ?? right.minimumUsd);
  if (leftExcess !== rightExcess) return rightExcess - leftExcess;
  const leftRemovable =
    (values.get(left.channelId) ?? left.minimumUsd) - left.minimumUsd;
  const rightRemovable =
    (values.get(right.channelId) ?? right.minimumUsd) - right.minimumUsd;
  if (leftRemovable !== rightRemovable) return rightRemovable - leftRemovable;
  return channelIndex(right.channelId) - channelIndex(left.channelId);
}

function channelIndex(channelId: PortfolioChannelId): number {
  return PORTFOLIO_CHANNEL_IDS.indexOf(channelId);
}

function totalFor(values: Map<PortfolioChannelId, number>): number {
  return [...values.values()].reduce((sum, value) => sum + value, 0);
}

function roundToIncrement(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value > 0
    ? value
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
