import { describe, expect, it } from "vitest";

import { composeTau3RetailOutcomeReward } from "./tau3-retail-reward.js";

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
