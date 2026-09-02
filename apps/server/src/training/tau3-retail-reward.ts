export const TAU3_RETAIL_TERMINAL_STATE_GRADER_ID = "tau3-retail-terminal-state-v1";
export const TAU3_RETAIL_OUTCOME_RUBRIC_GRADER_ID = "tau3-retail-outcome-rubric-v2";
export const TAU3_RETAIL_OUTCOME_RUBRIC_V3_GRADER_ID = "tau3-retail-outcome-rubric-v3";

export type Tau3RetailOutcomeEvidence = {
  terminalState: number;
  requiredWriteCoverage: number;
  requiredReadCoverage: number;
  toolValidity: number;
  resolvedCommunication: number;
  prematureMutation: number;
  unexpectedMutation: number;
  invalidToolRate: number;
};

export type Tau3RetailReward = {
  reward: number;
  components: Tau3RetailOutcomeEvidence & { baseReward: number };
};

export type Tau3RetailOutcomeEvidenceV3 = Tau3RetailOutcomeEvidence & {
  requiredWritesApplicable: boolean;
  requiredReadsApplicable: boolean;
  toolValidityApplicable: boolean;
};

export type Tau3RetailRewardV3 = {
  reward: number;
  components: Tau3RetailOutcomeEvidence & {
    requiredWritesApplicable: number;
    requiredReadsApplicable: number;
    toolValidityApplicable: number;
    baseReward: number;
  };
};

/**
 * Compose the public, immutable v2 Retail outcome rubric. The bridge derives
 * evidence from privileged expected actions and final state; policy inference
 * never receives those targets.
 */
export function composeTau3RetailOutcomeReward(
  evidence: Tau3RetailOutcomeEvidence,
): Tau3RetailReward {
  const components = Object.fromEntries(
    Object.entries(evidence).map(([key, value]) => [key, unit(value, key)]),
  ) as Tau3RetailOutcomeEvidence;
  const baseReward = (
    0.50 * components.terminalState
    + 0.25 * components.requiredWriteCoverage
    + 0.15 * components.requiredReadCoverage
    + 0.05 * components.toolValidity
    + 0.05 * components.resolvedCommunication
  );
  const reward = clamp(
    baseReward
    - 0.50 * components.prematureMutation
    - 0.35 * components.unexpectedMutation
    - 0.10 * components.invalidToolRate,
    -1,
    1,
  );
  return {
    reward,
    components: { ...components, baseReward },
  };
}

/**
 * Compose immutable v3 evidence with applicability-aware positive weights.
 * Missing read, write, or tool-call requirements are excluded rather than
 * awarded as automatic successes. Safety penalties remain applicable to every
 * attempted trajectory and preserve the public [-1, 1] reward range.
 */
export function composeTau3RetailOutcomeRewardV3(
  evidence: Tau3RetailOutcomeEvidenceV3,
): Tau3RetailRewardV3 {
  const numeric = Object.fromEntries(
    Object.entries(evidence)
      .filter(([, value]) => typeof value === "number")
      .map(([key, value]) => [key, unit(value as number, key)]),
  ) as Tau3RetailOutcomeEvidence;
  const positive = [
    { value: numeric.terminalState, weight: 0.50, applicable: true },
    { value: numeric.requiredWriteCoverage, weight: 0.25, applicable: evidence.requiredWritesApplicable },
    { value: numeric.requiredReadCoverage, weight: 0.15, applicable: evidence.requiredReadsApplicable },
    { value: numeric.toolValidity, weight: 0.05, applicable: evidence.toolValidityApplicable },
    { value: numeric.resolvedCommunication, weight: 0.05, applicable: true },
  ].filter((component) => component.applicable);
  const positiveWeight = positive.reduce((sum, component) => sum + component.weight, 0);
  const baseReward = positive.reduce(
    (sum, component) => sum + component.value * component.weight,
    0,
  ) / positiveWeight;
  const reward = clamp(
    baseReward
    - 0.50 * numeric.prematureMutation
    - 0.35 * numeric.unexpectedMutation
    - 0.10 * numeric.invalidToolRate,
    -1,
    1,
  );
  return {
    reward,
    components: {
      ...numeric,
      requiredWritesApplicable: Number(evidence.requiredWritesApplicable),
      requiredReadsApplicable: Number(evidence.requiredReadsApplicable),
      toolValidityApplicable: Number(evidence.toolValidityApplicable),
      baseReward,
    },
  };
}

function unit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`tau3_retail_${label}_must_be_a_finite_unit_interval_number`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
