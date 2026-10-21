import { z } from "zod";

const RequestSchema = z.object({
  mode: z.literal("frozen_evaluation"),
  target: z.enum(["checkpoint", "base_model"]),
  representation: z.enum(["adapter", "merged_backbone"]).optional(),
  checkpointId: z.string().min(8).max(191),
  artifact: z.object({ id: z.string().min(8), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  idempotencyKey: z.string().min(16).max(191),
  quote: z.record(z.string(), z.unknown()),
  quoteSignature: z.string().min(32),
  maximumSpendUsd: z.number().positive().max(10),
  maxGpuSeconds: z.number().int().positive().max(7200),
}).strict();

/** Loads the exact signed final checkpoint. Tasks, sampling and source are inherited;
 * the request cannot replace them or allocate another trainable adapter block. */
export const parseCheckpointEvaluationRequest = (input: unknown) => RequestSchema.parse(input);

export function parseCheckpointEvaluationResponse(value: unknown, request: z.infer<typeof RequestSchema>) {
  const result = z.object({ job: z.object({ id: z.string().min(1), idempotencyKey: z.string(),
    targetGroups: z.literal(0), canonicalPublishState: z.literal("skipped"), publicSubmission: z.null(),
  }).passthrough() }).parse(value);
  if (result.job.idempotencyKey !== request.idempotencyKey) throw new Error("Checkpoint evaluation response identity mismatch.");
  return result;
}
