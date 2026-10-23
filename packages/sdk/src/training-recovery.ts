import { z } from "zod";
import { canonicalSha256 } from "./protocol.js";

const id = z.string().trim().min(1).max(191);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ApprovalBodySchema = z
  .object({
    schemaVersion: z.literal("openpond.checkpointRecoveryResourceApproval.v1"),
    ownerUserId: id,
    teamId: id,
    sourceJobId: id,
    sourceJobVersion: z.number().int().positive(),
    sourceInputManifestSha256: hash,
    checkpointId: id,
    adapterSha256: hash,
    resumeSha256: hash,
    idempotencyKey: z.string().trim().min(16).max(191),
    approvedAt: z.iso.datetime({ offset: true }),
    maximumSpendUsd: z
      .number()
      .positive()
      .finite()
      .max(30)
      .refine(
        (value) => Number(value.toFixed(6)) === value,
        "Recovery spend must use whole microdollars",
      ),
    maximumGpuSeconds: z.number().int().positive().max(21_600),
    maximumWallSeconds: z.number().int().positive().max(21_600),
  })
  .strict();

export const TrainingCheckpointRecoveryResourceApprovalSchema = ApprovalBodySchema.extend({
  approvalHash: hash,
})
  .strict()
  .superRefine((value, context) => {
    if (value.maximumGpuSeconds > value.maximumWallSeconds)
      context.addIssue({
        code: "custom",
        path: ["maximumGpuSeconds"],
        message: "Recovery GPU duration exceeds its wall",
      });
  });

/** The authenticated source owner's funded request is consent; this hash binds its exact scope. */
export async function createTrainingCheckpointRecoveryResourceApproval(
  input: z.input<typeof ApprovalBodySchema>,
) {
  const body = ApprovalBodySchema.parse(input);
  return TrainingCheckpointRecoveryResourceApprovalSchema.parse({
    ...body,
    approvalHash: await canonicalSha256(body),
  });
}

/** Exact execution recovery; a continual-training optimizer reset is separate. */
export const TrainingCheckpointRecoveryRequestSchema = z
  .object({
    resourceApproval: TrainingCheckpointRecoveryResourceApprovalSchema.optional(),
    mode: z.literal("evaluation_only").optional(),
    evaluationGpuType: z
      .enum(["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA H100 80GB HBM3"])
      .optional(),
    expectedVersion: z.number().int().positive(),
    checkpointId: id,
    idempotencyKey: z.string().trim().min(16).max(191),
    maximumSpendUsd: z.number().positive().finite(),
    maximumWallSeconds: z.number().int().positive().max(21_600),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evaluationGpuType && value.mode !== "evaluation_only")
      context.addIssue({
        code: "custom",
        path: ["evaluationGpuType"],
        message: "GPU substitution requires explicit evaluation-only recovery",
      });
    const a = value.resourceApproval;
    if (
      a &&
      (a.sourceJobVersion !== value.expectedVersion ||
        a.checkpointId !== value.checkpointId ||
        a.idempotencyKey !== value.idempotencyKey ||
        a.maximumSpendUsd !== value.maximumSpendUsd ||
        a.maximumWallSeconds !== value.maximumWallSeconds)
    )
      context.addIssue({
        code: "custom",
        path: ["resourceApproval"],
        message: "Recovery resource approval does not match its request",
      });
  });
