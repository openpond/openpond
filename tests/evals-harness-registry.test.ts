import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import "../apps/server/src/training/marketing-portfolio-managed-rl-adapter.js";
import { createManagedRlHarnessAttemptReceipt } from "../apps/server/src/training/marketing-portfolio-managed-rl-adapter.js";
import { rewardEligibleReceipts, verifyAttemptReceipt } from "../packages/evals/src/index.js";
import {
  registerManagedRlHarnessAdapter,
  resolveManagedRlHarnessAdapter,
} from "../apps/server/src/training/managed-rl-harness-registry.js";
import { tasksetFixture } from "./helpers/training-fixtures.js";

describe("managed RL Harness registry", () => {
  it("adds a domain-neutral compatible adapter without changing generic execution", () => {
    const taskset = tasksetFixture();
    taskset.environment.metadata.runtimeAdapterId = "fixture-generic-tool-v1";
    registerManagedRlHarnessAdapter({
      id: "fixture-generic-tool-v1",
      supports: ({ taskset: candidate, environmentId }) =>
        environmentId === "fixture-generic-tool-v1"
        && candidate.environment.metadata.runtimeAdapterId === environmentId,
      async execute() { return { status: "succeeded" }; },
    });
    expect(resolveManagedRlHarnessAdapter({
      taskset,
      environmentId: "fixture-generic-tool-v1",
    }).id).toBe("fixture-generic-tool-v1");
  });

  it("keeps benchmark and scorer identifiers out of generic package/runtime modules", async () => {
    const files = [
      "packages/evals/src/common.ts",
      "packages/evals/src/graders.ts",
      "packages/evals/src/harness.ts",
      "packages/evals/src/runs.ts",
      "packages/evals/src/tasksets.ts",
      "apps/server/src/training/managed-rl-local-rollout-executor.ts",
      "apps/server/src/training/managed-rl-harness-registry.ts",
      "apps/server/src/training/openpond-managed-training-adapter.ts",
    ];
    for (const file of files) {
      const source = await readFile(path.resolve(file), "utf8");
      expect(source, file).not.toMatch(/marketing-portfolio-v1|scoreBudgetDecision|portfolioValue/);
    }
  });

  it("projects managed rollout reward evidence into the canonical receipt", () => {
    const receipt = createManagedRlHarnessAttemptReceipt({
      claim: {
        schemaVersion: "openpond.managedRlLocalRolloutClaim.v1",
        executionKind: "rollout",
        executionId: "rollout-fixture",
        jobId: "job-fixture",
        groupId: "group-fixture",
        rolloutId: "rollout-fixture",
        deliveryId: "delivery-fixture",
        policyVersion: 2,
        task: { id: "task-fixture", expectedText: null },
        taskset: { id: "taskset-fixture", revision: 1, contentHash: "b".repeat(64) },
        harnessRelease: { id: "harness-fixture", contentHash: "c".repeat(64) },
        reward: { kind: "local_harness_receipt_v1", environmentId: "fixture" },
        environmentSha256: "a".repeat(64),
        request: { seed: 17 },
        policy: { path: "/policy", token: "opaque-test-token" },
      },
      taskId: "task-fixture",
      seed: 17,
      rollout: {
        traceSha256: "d".repeat(64),
        reward: 0.75,
        components: { deterministic: 0.75 },
        terminal: true,
        toolSequence: ["lookup", "submit"],
      },
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:01.000Z",
    });
    expect(verifyAttemptReceipt(receipt)).toBe(true);
    expect(rewardEligibleReceipts([receipt])).toEqual([receipt]);
    expect(JSON.stringify(receipt)).not.toContain("opaque-test-token");
    expect(receipt).toMatchObject({
      traceHash: "d".repeat(64),
      metadata: { score: 0.75, rewardEligible: true },
    });
  });
});
