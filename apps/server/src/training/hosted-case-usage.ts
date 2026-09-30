import { z } from "zod";
import type { ModelTasksetRunDetails, ModelTasksetRunResult } from "openpond-sdk/model-taskset-runs";
const Measured = z.number().finite().nonnegative().nullable();
const Call = z.object({ totalTokens: Measured, costUsd: Measured });
const Compute = z.object({ costUsd: Measured, sandboxId: z.string().max(500).nullable(), receiptId: z.string().max(500).nullable() });
/** Select only bounded accounting fields. Attempt metadata can contain other
 * evidence; none of that enters this renderer projection. */
export function projectHostedCaseUsage(run: ModelTasksetRunDetails, result: ModelTasksetRunResult, receiptId: string) {
  if (result.run.summary.id !== run.summary.id || result.run.summary.manifestHash !== run.summary.manifestHash) throw new Error("Case usage differs from its retained execution.");
  const receipt = result.receipts.find(item => item.id === receiptId);
  if (!receipt || !run.request.population.some(item => item.receiptId === receipt.id && item.taskId === receipt.taskId && item.seed === receipt.seed)) throw new Error("Case usage receipt is unavailable in this execution.");
  const metadata = z.record(z.string(), z.unknown()).safeParse(receipt.metadata.usageBreakdown);
  const raw = metadata.success ? metadata.data : {};
  const measured = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const call = (value: unknown) => { const data = z.record(z.string(), z.unknown()).safeParse(value); return Call.parse({ totalTokens: measured(data.success ? data.data.totalTokens : null), costUsd: measured(data.success ? data.data.costUsd : null) }); };
  const compute = z.record(z.string(), z.unknown()).safeParse(raw.compute);
  return { executionId: run.summary.id, receiptId, policy: call(raw.policy), grader: call(raw.grader), compute: compute.success ? Compute.parse({ costUsd: measured(compute.data.costUsd), sandboxId: typeof compute.data.sandboxId === "string" ? compute.data.sandboxId : null, receiptId: typeof compute.data.receiptId === "string" ? compute.data.receiptId : null }) : null };
}
