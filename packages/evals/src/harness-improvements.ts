import { z } from "zod";

import {
  HarnessImprovementRouteSchema,
  HarnessOverlaySnapshotRefSchema,
} from "./harness-workspaces.js";
import {
  contentHash,
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./common.js";

const BoundedTextSchema = z.string().trim().min(1).max(100_000);
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const ImprovementSafeBoundaryKindSchema = z.enum([
  "completed_tool_batch",
  "before_model_step",
  "turn_completed",
  "turn_paused",
]);

export const ImprovementSafeBoundarySchema = z
  .object({
    kind: ImprovementSafeBoundaryKindSchema,
    eventSequence: z.number().int().nonnegative(),
    occurredAt: ReleaseTimestampSchema,
  })
  .strict();

export const ImprovementEventRefSchema = z
  .object({
    id: ReleaseIdSchema,
    sequence: z.number().int().nonnegative().nullable(),
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const ImprovementObservationKindSchema = z.enum([
  "tool_failure",
  "retry",
  "recovery",
  "validation",
  "user_correction",
  "reusable_success",
  "completion_detour",
]);

export const ImprovementObservationStateSchema = z.enum([
  "open",
  "recovered",
  "terminal",
]);

export const ImprovementToolIdentitySchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    invocationKey: ReleaseHashSchema,
  })
  .strict();

export const ImprovementObservationContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.improvementObservation.v1"),
    id: ReleaseIdSchema,
    runRef: ReleaseIdSchema,
    turnId: ReleaseIdSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    overlay: HarnessOverlaySnapshotRefSchema.nullable(),
    eventRefs: z.array(ImprovementEventRefSchema).min(1).max(100),
    kind: ImprovementObservationKindSchema,
    state: ImprovementObservationStateSchema,
    tool: ImprovementToolIdentitySchema.nullable(),
    deterministicClass: z.string().trim().min(1).max(500).nullable(),
    summary: BoundedTextSchema,
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      new Set(observation.eventRefs.map((reference) => reference.id)).size !==
      observation.eventRefs.length
    ) {
      context.addIssue({
        code: "custom",
        message: "observation event refs must be unique",
        path: ["eventRefs"],
      });
    }
    if (
      ["tool_failure", "retry", "recovery", "completion_detour"].includes(
        observation.kind,
      ) &&
      observation.tool === null
    ) {
      context.addIssue({
        code: "custom",
        message: `${observation.kind} observations require a tool identity`,
        path: ["tool"],
      });
    }
  });

export const ImprovementObservationSchema =
  ImprovementObservationContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const RefinementTriggerPolicySchema = z
  .object({
    schemaVersion: z.literal("openpond.refinementTriggerPolicy.v1"),
    maxEstimatedCostUsd: z.number().finite().nonnegative(),
    cooldownMs: z.number().int().nonnegative(),
    maxPendingPlans: z.number().int().min(1).max(100),
    maxEvidenceEvents: z.number().int().min(1).max(1_000),
    maxProposalEdits: z.number().int().min(1).max(1_000),
    maxProposalBytes: z.number().int().min(1).max(10_000_000),
  })
  .strict();

export const RefinementTriggerDecisionKindSchema = z.enum([
  "no_action",
  "route_deterministically",
  "queue_refiner",
]);

export const RefinementTriggerDecisionContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.refinementTriggerDecision.v1"),
    id: ReleaseIdSchema,
    runRef: ReleaseIdSchema,
    turnId: ReleaseIdSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    overlay: HarnessOverlaySnapshotRefSchema.nullable(),
    observations: z.array(ImmutableReleaseRefSchema).max(100),
    decision: RefinementTriggerDecisionKindSchema,
    deterministicRoute: HarnessImprovementRouteSchema.nullable(),
    suggestedRoutes: z.array(HarnessImprovementRouteSchema).max(8),
    reason: BoundedTextSchema,
    deduplicationKey: ReleaseHashSchema,
    policy: RefinementTriggerPolicySchema,
    estimatedMaxCostUsd: z.number().finite().nonnegative(),
    pendingPlanCount: z.number().int().nonnegative(),
    boundary: ImprovementSafeBoundarySchema,
    cooldownUntil: ReleaseTimestampSchema.nullable(),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((trigger, context) => {
    if (trigger.estimatedMaxCostUsd > trigger.policy.maxEstimatedCostUsd) {
      context.addIssue({
        code: "custom",
        message: "estimated Refiner cost exceeds the trigger policy budget",
        path: ["estimatedMaxCostUsd"],
      });
    }
    if (trigger.pendingPlanCount > trigger.policy.maxPendingPlans) {
      context.addIssue({
        code: "custom",
        message: "pending plan count exceeds the trigger policy limit",
        path: ["pendingPlanCount"],
      });
    }
    if (trigger.observations.length > trigger.policy.maxEvidenceEvents) {
      context.addIssue({
        code: "custom",
        message: "trigger observations exceed the evidence budget",
        path: ["observations"],
      });
    }
    if (
      trigger.decision === "route_deterministically" &&
      trigger.deterministicRoute === null
    ) {
      context.addIssue({
        code: "custom",
        message: "deterministic decisions require a route",
        path: ["deterministicRoute"],
      });
    }
    if (
      trigger.decision !== "route_deterministically" &&
      trigger.deterministicRoute !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "only deterministic decisions may declare a deterministic route",
        path: ["deterministicRoute"],
      });
    }
    if (trigger.decision === "no_action" && trigger.suggestedRoutes.length > 0) {
      context.addIssue({
        code: "custom",
        message: "no-action decisions cannot suggest routes",
        path: ["suggestedRoutes"],
      });
    }
    if (trigger.decision !== "no_action" && trigger.observations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "actionable trigger decisions require observations",
        path: ["observations"],
      });
    }
  });

export const RefinementTriggerDecisionSchema =
  RefinementTriggerDecisionContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const ImprovementRouteAuthoritySchema = z.enum([
  "runtime_service",
  "refiner_model",
  "human_review",
  "evaluation_system",
  "training_system",
]);

export const ImprovementRouteDecisionContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.improvementRouteDecision.v1"),
    id: ReleaseIdSchema,
    trigger: ImmutableReleaseRefSchema,
    route: HarnessImprovementRouteSchema,
    authority: ImprovementRouteAuthoritySchema,
    automatic: z.boolean(),
    reason: BoundedTextSchema,
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      decision.automatic &&
      ["human_review", "evaluation_system", "training_system"].includes(
        decision.authority,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: `${decision.authority} routes cannot be marked automatic`,
        path: ["automatic"],
      });
    }
    if (
      decision.route === "training" &&
      decision.automatic &&
      decision.authority !== "training_system"
    ) {
      context.addIssue({
        code: "custom",
        message: "automatic training routes require training-system authority",
        path: ["authority"],
      });
    }
  });

export const ImprovementRouteDecisionSchema =
  ImprovementRouteDecisionContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessRefinerOutcomeContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRefinerOutcome.v1"),
    id: ReleaseIdSchema,
    trigger: ImmutableReleaseRefSchema,
    decision: z.enum(["no_action", "proposed"]),
    proposal: ImmutableReleaseRefSchema.nullable(),
    reason: BoundedTextSchema,
    evidenceRefs: z.array(ImmutableReleaseRefSchema).max(100),
    estimatedCostUsd: z.number().finite().nonnegative(),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((outcome, context) => {
    if ((outcome.decision === "proposed") !== (outcome.proposal !== null)) {
      context.addIssue({
        code: "custom",
        message: "proposed Refiner outcomes require a proposal; no-action outcomes cannot include one",
        path: ["proposal"],
      });
    }
  });

export const HarnessRefinerOutcomeSchema =
  HarnessRefinerOutcomeContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const ImprovementApplyDecisionSchema = z.enum([
  "applied",
  "retained",
  "declined",
  "conflict",
  "rolled_back",
]);

export const ImprovementApplyReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.improvementApplyReceipt.v1"),
    id: ReleaseIdSchema,
    proposal: ImmutableReleaseRefSchema,
    beforeOverlay: HarnessOverlaySnapshotRefSchema,
    afterOverlay: HarnessOverlaySnapshotRefSchema.nullable(),
    decision: ImprovementApplyDecisionSchema,
    boundary: ImprovementSafeBoundarySchema,
    validationRefs: z.array(ImmutableReleaseRefSchema).max(100),
    outcomeEvidenceRefs: z.array(ImprovementEventRefSchema).max(1_000),
    rollbackOf: ImmutableReleaseRefSchema.nullable(),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if ((receipt.decision === "applied") !== (receipt.afterOverlay !== null)) {
      context.addIssue({
        code: "custom",
        message: "applied receipts require an after-overlay; other decisions cannot include one",
        path: ["afterOverlay"],
      });
    }
    if ((receipt.decision === "rolled_back") !== (receipt.rollbackOf !== null)) {
      context.addIssue({
        code: "custom",
        message: "only rollback receipts require rollbackOf",
        path: ["rollbackOf"],
      });
    }
  });

export const ImprovementApplyReceiptSchema =
  ImprovementApplyReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

function createHashedContract<TContent, TResult>(input: {
  content: unknown;
  contentSchema: z.ZodType<TContent>;
  resultSchema: z.ZodType<TResult>;
}): TResult {
  const parsed = input.contentSchema.parse(input.content);
  return input.resultSchema.parse({
    ...(parsed as Record<string, unknown>),
    contentHash: contentHash(parsed),
  });
}

export function createImprovementObservation(
  content: z.input<typeof ImprovementObservationContentSchema>,
): ImprovementObservation {
  return createHashedContract({
    content,
    contentSchema: ImprovementObservationContentSchema,
    resultSchema: ImprovementObservationSchema,
  });
}

export function createRefinementTriggerDecision(
  content: z.input<typeof RefinementTriggerDecisionContentSchema>,
): RefinementTriggerDecision {
  return createHashedContract({
    content,
    contentSchema: RefinementTriggerDecisionContentSchema,
    resultSchema: RefinementTriggerDecisionSchema,
  });
}

export function createImprovementRouteDecision(
  content: z.input<typeof ImprovementRouteDecisionContentSchema>,
): ImprovementRouteDecision {
  return createHashedContract({
    content,
    contentSchema: ImprovementRouteDecisionContentSchema,
    resultSchema: ImprovementRouteDecisionSchema,
  });
}

export function createHarnessRefinerOutcome(
  content: z.input<typeof HarnessRefinerOutcomeContentSchema>,
): HarnessRefinerOutcome {
  return createHashedContract({
    content,
    contentSchema: HarnessRefinerOutcomeContentSchema,
    resultSchema: HarnessRefinerOutcomeSchema,
  });
}

export function createImprovementApplyReceipt(
  content: z.input<typeof ImprovementApplyReceiptContentSchema>,
): ImprovementApplyReceipt {
  return createHashedContract({
    content,
    contentSchema: ImprovementApplyReceiptContentSchema,
    resultSchema: ImprovementApplyReceiptSchema,
  });
}

export type ImprovementSafeBoundaryKind = z.infer<
  typeof ImprovementSafeBoundaryKindSchema
>;
export type ImprovementSafeBoundary = z.infer<typeof ImprovementSafeBoundarySchema>;
export type ImprovementEventRef = z.infer<typeof ImprovementEventRefSchema>;
export type ImprovementObservationKind = z.infer<
  typeof ImprovementObservationKindSchema
>;
export type ImprovementObservationState = z.infer<
  typeof ImprovementObservationStateSchema
>;
export type ImprovementObservation = z.infer<typeof ImprovementObservationSchema>;
export type RefinementTriggerPolicy = z.infer<typeof RefinementTriggerPolicySchema>;
export type RefinementTriggerDecisionKind = z.infer<
  typeof RefinementTriggerDecisionKindSchema
>;
export type RefinementTriggerDecision = z.infer<
  typeof RefinementTriggerDecisionSchema
>;
export type ImprovementRouteAuthority = z.infer<
  typeof ImprovementRouteAuthoritySchema
>;
export type ImprovementRouteDecision = z.infer<typeof ImprovementRouteDecisionSchema>;
export type HarnessRefinerOutcome = z.infer<typeof HarnessRefinerOutcomeSchema>;
export type ImprovementApplyDecision = z.infer<typeof ImprovementApplyDecisionSchema>;
export type ImprovementApplyReceipt = z.infer<typeof ImprovementApplyReceiptSchema>;
