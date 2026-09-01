export const TAU3_RETAIL_TERMINAL_STATE_GRADER_ID = "tau3-retail-terminal-state-v1";
export const TAU3_RETAIL_OUTCOME_RUBRIC_GRADER_ID = "tau3-retail-outcome-rubric-v2";

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

function unit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`tau3_retail_${label}_must_be_a_finite_unit_interval_number`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
