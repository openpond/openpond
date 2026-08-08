import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
} from "./common.js";

const BoundedTextSchema = z.string().trim().min(1).max(100_000);

export const HarnessEvaluationReviewClassificationSchema = z.enum([
  "no_action",
  "harness_maintenance",
  "runtime",
  "product",
  "taskset",
  "model_improvement",
]);

export const HarnessEvaluationReviewAuthoritySchema = z.enum([
  "none",
  "runtime_service",
  "product_team",
  "human_review",
  "evaluation_system",
  "training_system",
]);

export const HarnessReviewEvidenceKindSchema = z.enum([
  "observation",
  "trigger",
  "route_decision",
  "refiner_outcome",
  "proposal",
  "validation",
  "apply_receipt",
  "harness_advance",
  "rollback",
  "work_outcome",
  "taskset",
  "evaluation",
  "training_qualification",
  "model_candidate",
]);

export const HarnessReviewOwnerScopeSchema = z
  .object({
    kind: z.enum(["personal", "team"]),
    id: ReleaseIdSchema,
  })
  .strict();

export const HarnessReviewSourcePolicyRefSchema = z
  .object({
    policy: ImmutableReleaseRefSchema,
    state: z.enum(["authorized", "revoked", "deleted", "expired"]),
    checkedAt: ReleaseTimestampSchema,
  })
  .strict();

export const HarnessReviewEvidenceRefSchema = z
  .object({
    evidence: ImmutableReleaseRefSchema,
    kind: HarnessReviewEvidenceKindSchema,
    sourceRef: ReleaseIdSchema,
    sourcePolicy: HarnessReviewSourcePolicyRefSchema,
    occurrenceKey: ReleaseHashSchema,
    occurredAt: ReleaseTimestampSchema,
  })
  .strict();

export const HarnessReviewExcludedEvidenceSchema = z
  .object({
    evidence: ImmutableReleaseRefSchema,
    sourcePolicy: HarnessReviewSourcePolicyRefSchema.nullable(),
    reason: z.enum([
      "outside_scope",
      "before_watermark",
      "duplicate",
      "resolved",
      "revoked",
      "deleted",
      "expired",
      "sensitive",
      "unverified",
      "budget",
    ]),
  })
  .strict();

export const HarnessReviewWatermarkSchema = z
  .object({
    cursor: ReleaseHashSchema,
    throughCreatedAt: ReleaseTimestampSchema,
  })
  .strict();

export const HarnessReviewClaimSchema = z
  .object({
    fingerprint: ReleaseHashSchema,
    recurrenceFamily: z.string().trim().min(1).max(1_000),
    statement: BoundedTextSchema,
    independentOccurrences: z.number().int().positive().max(1_000_000),
    unresolvedOccurrences: z.number().int().positive().max(1_000_000),
  })
  .strict()
  .refine(
    (claim) => claim.unresolvedOccurrences <= claim.independentOccurrences,
    "unresolved occurrences cannot exceed independent occurrences",
  );

export const HarnessReviewTriageLayerSchema = z.enum([
  "harness",
  "runtime",
  "product",
  "retrieval",
  "tools",
  "evaluation",
  "model",
]);

export const HarnessReviewTriageDecisionSchema = z
  .object({
    layer: HarnessReviewTriageLayerSchema,
    status: z.enum(["not_applicable", "unresolved", "resolved", "blocked"]),
    reason: BoundedTextSchema,
    evidenceRefs: z.array(ImmutableReleaseRefSchema).max(1_000),
  })
  .strict();

export const HarnessEvaluationReviewReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessEvaluationReviewReceipt.v1"),
    id: ReleaseIdSchema,
    ownerScope: HarnessReviewOwnerScopeSchema,
    workspaceRef: ReleaseIdSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    previousWatermark: HarnessReviewWatermarkSchema.nullable(),
    nextWatermark: HarnessReviewWatermarkSchema,
    selectedEvidence: z.array(HarnessReviewEvidenceRefSchema).max(10_000),
    excludedEvidence: z.array(HarnessReviewExcludedEvidenceSchema).max(10_000),
    claim: HarnessReviewClaimSchema.nullable(),
    classification: HarnessEvaluationReviewClassificationSchema,
    triage: z.array(HarnessReviewTriageDecisionSchema).max(16),
    reason: BoundedTextSchema,
    nextAuthority: HarnessEvaluationReviewAuthoritySchema,
    maxEstimatedCostUsd: z.number().finite().nonnegative(),
    tasksetProposal: ImmutableReleaseRefSchema.nullable(),
    evaluation: ImmutableReleaseRefSchema.nullable(),
    trainingQualification: ImmutableReleaseRefSchema.nullable(),
    policyVersion: ReleaseIdSchema,
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const selectedKeys = receipt.selectedEvidence.map(
      (item) => `${item.evidence.id}:${item.evidence.contentHash}`,
    );
    if (new Set(selectedKeys).size !== selectedKeys.length) {
      context.addIssue({
        code: "custom",
        message: "selected review evidence must be unique",
        path: ["selectedEvidence"],
      });
    }
    if (
      receipt.selectedEvidence.some(
        (item) => item.sourcePolicy.state !== "authorized",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "selected review evidence must be authorized at review time",
        path: ["selectedEvidence"],
      });
    }
    if (receipt.classification === "no_action") {
      if (receipt.nextAuthority !== "none") {
        context.addIssue({
          code: "custom",
          message: "no-action review receipts require no next authority",
          path: ["nextAuthority"],
        });
      }
      if (
        receipt.tasksetProposal ||
        receipt.evaluation ||
        receipt.trainingQualification
      ) {
        context.addIssue({
          code: "custom",
          message: "no-action review receipts cannot carry downstream refs",
        });
      }
    } else if (!receipt.claim || receipt.selectedEvidence.length === 0) {
      context.addIssue({
        code: "custom",
        message: "actionable review receipts require a claim and selected evidence",
      });
    }
    if (
      receipt.classification === "runtime" &&
      receipt.nextAuthority !== "runtime_service"
    ) {
      context.addIssue({
        code: "custom",
        message: "runtime classifications route to runtime-service authority",
        path: ["nextAuthority"],
      });
    }
    if (
      receipt.classification === "product" &&
      receipt.nextAuthority !== "product_team"
    ) {
      context.addIssue({
        code: "custom",
        message: "product classifications route to product-team authority",
        path: ["nextAuthority"],
      });
    }
    if (
      receipt.classification === "taskset" &&
      receipt.nextAuthority !== "human_review"
    ) {
      context.addIssue({
        code: "custom",
        message: "Taskset classifications require human review",
      });
    }
    if (
      receipt.classification === "model_improvement" &&
      (!receipt.evaluation ||
        !receipt.trainingQualification ||
        !["human_review", "training_system"].includes(receipt.nextAuthority))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "model-improvement classifications require Evaluation and qualification refs plus explicit authority",
      });
    }
  });

export const HarnessEvaluationReviewReceiptSchema =
  HarnessEvaluationReviewReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export function createHarnessEvaluationReviewReceipt(
  input: z.input<typeof HarnessEvaluationReviewReceiptContentSchema>,
): HarnessEvaluationReviewReceipt {
  const content = HarnessEvaluationReviewReceiptContentSchema.parse(input);
  return HarnessEvaluationReviewReceiptSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

export function verifyHarnessEvaluationReviewReceipt(
  value: unknown,
): value is HarnessEvaluationReviewReceipt {
  const parsed = HarnessEvaluationReviewReceiptSchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(HarnessEvaluationReviewReceiptContentSchema.parse(content)) === actual;
}

export type HarnessEvaluationReviewReceipt = z.infer<
  typeof HarnessEvaluationReviewReceiptSchema
>;
export type HarnessReviewEvidenceRef = z.infer<
  typeof HarnessReviewEvidenceRefSchema
>;
