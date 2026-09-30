import { expect, it } from "vitest";
import type { ModelTasksetRunDetails, ModelTasksetRunResult } from "openpond-sdk/model-taskset-runs";
import { projectHostedCaseUsage } from "../apps/server/src/training/hosted-case-usage.js";
// Attempt metadata is extensible. A new private field must never cross into the
// renderer just because accounting starts reading that same metadata object.
it("projects only measured accounting from an exact execution member", () => {
  const run = { summary: { id: "execution-a", manifestHash: "a".repeat(64) }, request: { population: [{ receiptId: "receipt-a", taskId: "task-a", seed: "0" }] } } as unknown as ModelTasksetRunDetails;
  const result = { run, receipts: [{ id: "receipt-a", taskId: "task-a", seed: "0", metadata: { expectedOutput: { secret: true }, usageBreakdown: { policy: { totalTokens: 8, costUsd: 0.01, privateInput: "private" }, grader: { totalTokens: null, costUsd: null }, compute: { costUsd: null, sandboxId: "sandbox-a", receiptId: "compute-a", privateObjectKey: "private" } } } }] } as unknown as ModelTasksetRunResult;
  expect(projectHostedCaseUsage(run, result, "receipt-a")).toEqual({ executionId: "execution-a", receiptId: "receipt-a", policy: { totalTokens: 8, costUsd: 0.01 }, grader: { totalTokens: null, costUsd: null }, compute: { costUsd: null, sandboxId: "sandbox-a", receiptId: "compute-a" } });
  expect(() => projectHostedCaseUsage(run, result, "foreign-receipt")).toThrow("unavailable");
  expect(() => projectHostedCaseUsage(run, { ...result, run: { ...run, summary: { ...run.summary, manifestHash: "b".repeat(64) } } }, "receipt-a")).toThrow("retained execution");
  expect(projectHostedCaseUsage(run, { ...result, receipts: [{ ...result.receipts[0]!, metadata: {} }] }, "receipt-a").compute).toBeNull();
});
