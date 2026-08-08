import { z } from "zod";

import {
  HarnessReviewSourcePolicyRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ModelRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
} from "@openpond/harness";

const BoundedTextSchema = z.string().trim().min(1).max(100_000);

export const ModelImprovementDecisionSchema = z.enum([
  "no_training",
  "sft",
  "preference",
  "rl",
]);

export const ModelImprovementSignalSchema = z
  .object({
    kind: z.enum(["none", "demonstrations", "chosen_rejected", "scalar_reward"]),
    strength: z.enum(["absent", "weak", "usable"]),
    calibrated: z.boolean(),
    confounded: z.boolean(),
    variance: z.number().finite().nonnegative().nullable(),
    evidenceRefs: z.array(ImmutableReleaseRefSchema).max(100_000),
  })
  .strict();

export const ModelImprovementQualificationReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelImprovementQualificationReceipt.v1"),
    id: ReleaseIdSchema,
    review: ImmutableReleaseRefSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    tasksetRelease: ImmutableReleaseRefSchema.nullable(),
    baselineEvaluation: ImmutableReleaseRefSchema.nullable(),
    model: ModelRefSchema,
    environmentHash: ReleaseHashSchema.nullable(),
    toolContractHash: ReleaseHashSchema.nullable(),
    permissionContractHash: ReleaseHashSchema.nullable(),
    policyHash: ReleaseHashSchema.nullable(),
    verifierRef: ImmutableReleaseRefSchema.nullable(),
    sourcePolicies: z.array(HarnessReviewSourcePolicyRefSchema).max(10_000),
    trainingEvidenceRefs: z.array(ImmutableReleaseRefSchema).max(100_000),
    frozenEvaluationEvidenceRefs: z.array(ImmutableReleaseRefSchema).max(100_000),
    privacyApproval: ImmutableReleaseRefSchema.nullable(),
    budgetApproval: ImmutableReleaseRefSchema.nullable(),
    maximumCostUsd: z.number().finite().nonnegative(),
    signal: ModelImprovementSignalSchema,
    decision: ModelImprovementDecisionSchema,
    reasons: z.array(BoundedTextSchema).min(1).max(100),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const trainingKeys = new Set(
      receipt.trainingEvidenceRefs.map(refKey),
    );
    if (
      receipt.frozenEvaluationEvidenceRefs.some((reference) =>
        trainingKeys.has(refKey(reference)),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "frozen Evaluation evidence cannot be used as training evidence",
        path: ["frozenEvaluationEvidenceRefs"],
      });
    }
    if (receipt.decision === "no_training") return;
    const missingGate =
      !receipt.tasksetRelease ||
      !receipt.baselineEvaluation ||
      !receipt.environmentHash ||
      !receipt.toolContractHash ||
      !receipt.permissionContractHash ||
      !receipt.policyHash ||
      !receipt.verifierRef ||
      !receipt.privacyApproval ||
      !receipt.budgetApproval ||
      receipt.sourcePolicies.length === 0 ||
      receipt.sourcePolicies.some((policy) => policy.state !== "authorized") ||
      receipt.trainingEvidenceRefs.length === 0 ||
      receipt.signal.strength !== "usable" ||
      !receipt.signal.calibrated ||
      receipt.signal.confounded;
    if (missingGate) {
      context.addIssue({
        code: "custom",
        message:
          "qualified model improvement requires frozen lineage, authorized signal, privacy, and budget gates",
      });
    }
    if (
      receipt.decision === "sft" &&
      receipt.signal.kind !== "demonstrations"
    ) {
      context.addIssue({
        code: "custom",
        message: "SFT qualification requires demonstration signal",
        path: ["signal", "kind"],
      });
    }
    if (
      receipt.decision === "preference" &&
      receipt.signal.kind !== "chosen_rejected"
    ) {
      context.addIssue({
        code: "custom",
        message: "preference qualification requires chosen/rejected signal",
        path: ["signal", "kind"],
      });
    }
    if (
      receipt.decision === "rl" &&
      (receipt.signal.kind !== "scalar_reward" ||
        receipt.signal.variance === null ||
        receipt.signal.variance <= 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "RL qualification requires a usable scalar reward with variance",
        path: ["signal"],
      });
    }
  });

export const ModelImprovementQualificationReceiptSchema =
  ModelImprovementQualificationReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export function createModelImprovementQualificationReceipt(
  input: z.input<typeof ModelImprovementQualificationReceiptContentSchema>,
): ModelImprovementQualificationReceipt {
  const content = ModelImprovementQualificationReceiptContentSchema.parse(input);
  return ModelImprovementQualificationReceiptSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

export function verifyModelImprovementQualificationReceipt(
  value: unknown,
): value is ModelImprovementQualificationReceipt {
  const parsed = ModelImprovementQualificationReceiptSchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return (
    contentHash(
      ModelImprovementQualificationReceiptContentSchema.parse(content),
    ) === actual
  );
}

function refKey(reference: { id: string; contentHash: string }): string {
  return `${reference.id}:${reference.contentHash}`;
}

export type ModelImprovementQualificationReceipt = z.infer<
  typeof ModelImprovementQualificationReceiptSchema
>;
