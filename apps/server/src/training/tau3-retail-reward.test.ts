import { describe, expect, it } from "vitest";

import {
  composeTau3RetailOutcomeReward,
  composeTau3RetailOutcomeRewardV3,
} from "./tau3-retail-reward.js";

const evidence = (overrides: Partial<Parameters<typeof composeTau3RetailOutcomeReward>[0]> = {}) => ({
  terminalState: 0,
  requiredWriteCoverage: 0,
  requiredReadCoverage: 0,
  toolValidity: 1,
  resolvedCommunication: 1,
  prematureMutation: 0,
  unexpectedMutation: 0,
  invalidToolRate: 0,
  ...overrides,
});

describe("composeTau3RetailOutcomeReward", () => {
  it("awards the maximum declared score for an exact, complete outcome", () => {
    expect(composeTau3RetailOutcomeReward(evidence({
      terminalState: 1,
      requiredWriteCoverage: 1,
      requiredReadCoverage: 1,
    })).reward).toBe(1);
  });

  it("retains distinct signal for read and write progress", () => {
    const noAction = composeTau3RetailOutcomeReward(evidence({ toolValidity: 0 })).reward;
    const reads = composeTau3RetailOutcomeReward(evidence({ requiredReadCoverage: 1 })).reward;
    const writes = composeTau3RetailOutcomeReward(evidence({ requiredWriteCoverage: 1 })).reward;
    expect([noAction, reads, writes]).toEqual([0.05, 0.25, 0.35]);
    expect(new Set([noAction, reads, writes]).size).toBe(3);
  });

  it("penalizes invalid, premature, and unexpected calls independently", () => {
    expect(composeTau3RetailOutcomeReward(evidence({
      toolValidity: 0.5,
      invalidToolRate: 0.5,
    })).reward).toBeCloseTo(0.025);
    expect(composeTau3RetailOutcomeReward(evidence({ prematureMutation: 1 })).reward).toBe(-0.4);
    expect(composeTau3RetailOutcomeReward(evidence({ unexpectedMutation: 1 })).reward).toBeCloseTo(-0.25);
  });

  it("rejects non-finite and out-of-contract evidence", () => {
    expect(() => composeTau3RetailOutcomeReward(evidence({ terminalState: Number.NaN }))).toThrow();
    expect(() => composeTau3RetailOutcomeReward(evidence({ toolValidity: 1.1 }))).toThrow();
  });
});

const evidenceV3 = (
  overrides: Partial<Parameters<typeof composeTau3RetailOutcomeRewardV3>[0]> = {},
) => ({
  ...evidence(),
  requiredWritesApplicable: true,
  requiredReadsApplicable: true,
  toolValidityApplicable: true,
  ...overrides,
});

describe("composeTau3RetailOutcomeRewardV3", () => {
  it("renormalizes absent requirements instead of awarding automatic coverage", () => {
    const noAction = composeTau3RetailOutcomeRewardV3(evidenceV3({
      terminalState: 1,
      resolvedCommunication: 1,
      requiredWritesApplicable: false,
      requiredReadsApplicable: false,
      toolValidityApplicable: false,
    }));
    expect(noAction.reward).toBe(1);
    expect(noAction.components.requiredWritesApplicable).toBe(0);
    expect(noAction.components.requiredReadsApplicable).toBe(0);
    expect(noAction.components.toolValidityApplicable).toBe(0);
  });

  it("keeps read-only, write-only, and mixed partial progress distinct", () => {
    const readOnly = composeTau3RetailOutcomeRewardV3(evidenceV3({
      requiredWritesApplicable: false,
      requiredReadCoverage: 1,
    })).reward;
    const writeOnly = composeTau3RetailOutcomeRewardV3(evidenceV3({
      requiredReadsApplicable: false,
      requiredWriteCoverage: 1,
    })).reward;
    const mixed = composeTau3RetailOutcomeRewardV3(evidenceV3({
      requiredReadCoverage: 1,
      requiredWriteCoverage: 1,
    })).reward;
    expect(new Set([readOnly, writeOnly, mixed]).size).toBe(3);
  });

  it("applies safety penalties after applicability-aware composition", () => {
    const safe = composeTau3RetailOutcomeRewardV3(evidenceV3({
      terminalState: 1,
      requiredWriteCoverage: 1,
      requiredReadCoverage: 1,
    })).reward;
    const unsafe = composeTau3RetailOutcomeRewardV3(evidenceV3({
      terminalState: 1,
      requiredWriteCoverage: 1,
      requiredReadCoverage: 1,
      prematureMutation: 1,
      unexpectedMutation: 1,
      invalidToolRate: 0.5,
    })).reward;
    expect(safe).toBe(1);
    expect(unsafe).toBeCloseTo(0.1);
  });
});
