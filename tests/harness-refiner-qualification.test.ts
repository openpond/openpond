import { describe, expect, test } from "vitest";

import {
  HARNESS_REFINER_QUALIFICATION_MODEL,
  HARNESS_REFINER_QUALIFICATION_PROTOCOL_HASH,
  HARNESS_REFINER_QUALIFICATION_SCENARIOS,
} from "../benchmarks/harness-refiner/qualification/protocol.js";
import { buildHarnessRefinerQualificationTaskset } from
  "../benchmarks/harness-refiner/qualification/taskset.js";

describe("Harness Refiner qualification protocol", () => {
  test("pins six independent scenario oracles and the exact paid model", () => {
    expect(HARNESS_REFINER_QUALIFICATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "q1-clean-success",
      "q2-transient-recovery",
      "q3-runtime-owned-failure",
      "q4-deterministic-html-defect",
      "q5-fact-distinct-transfer",
      "q6-recurring-cross-work",
    ]);
    expect(HARNESS_REFINER_QUALIFICATION_MODEL).toEqual({
      providerId: "openpond",
      modelId: "accounts/fireworks/models/deepseek-v4-flash",
    });
    expect(HARNESS_REFINER_QUALIFICATION_PROTOCOL_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  test("keeps adaptation and fact-distinct transfer in separate clusters", () => {
    const taskset = buildHarnessRefinerQualificationTaskset();
    expect(taskset.tasks).toHaveLength(3);
    const q4 = taskset.tasks.find((task) => task.id.includes("q4"));
    const q5 = taskset.tasks.find((task) => task.id.includes("q5"));
    expect(q4?.split).toBe("train");
    expect(q5?.split).toBe("frozen_eval");
    expect(q4?.clusterKey).not.toBe(q5?.clusterKey);
    expect(q4?.input.prompt).not.toEqual(q5?.input.prompt);
    expect(taskset.graders).toEqual([
      expect.objectContaining({
        kind: "state",
        hardGate: true,
        rewardEligible: true,
      }),
    ]);
    expect(JSON.stringify(taskset)).not.toMatch(/Will Brown|willccbb/i);
  });
});
