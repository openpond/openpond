import { z } from "zod";

import {
  contentHash,
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./common.js";

const MetadataSchema = z.record(z.string(), z.unknown()).default({});
const RevisionSchema = z.number().int().nonnegative();
const BoundedTextSchema = z.string().trim().min(1).max(100_000);

export const HarnessOwnerScopeSchema = z
  .object({
    kind: z.enum(["personal", "team"]),
    id: ReleaseIdSchema,
  })
  .strict();

export const HarnessCurrentChannelSchema = z
  .object({
    name: ReleaseIdSchema,
    release: ImmutableReleaseRefSchema.nullable(),
    revision: RevisionSchema,
  })
  .strict();

/**
 * Mutable, host-owned authoring state. Portable runs never consume this object;
 * they consume the immutable release selected from currentChannel.
 */
export const HarnessWorkspaceSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessWorkspace.v1"),
    id: ReleaseIdSchema,
    ownerScope: HarnessOwnerScopeSchema,
    name: z.string().trim().min(1).max(240),
    location: z.enum(["local", "hosted"]),
    sourceRevision: z.string().trim().min(1).max(500),
    revision: RevisionSchema,
    dirty: z.boolean(),
    currentChannel: HarnessCurrentChannelSchema,
    createdAt: ReleaseTimestampSchema,
    updatedAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict();

export const HarnessImprovementRouteSchema = z.enum([
  "runtime",
  "memory",
  "prompt",
  "skill",
  "agent",
  "product",
  "taskset",
  "training",
]);

export const HarnessChangeEffectSchema = z.enum([
  "text_instruction",
  "memory",
  "dependency_selection",
  "executable_code",
  "business_logic",
  "financial_logic",
  "permission",
  "connected_app",
  "publication",
  "deployment",
  "training",
  "model_binding",
  "team_or_global",
]);

export const HarnessOverlayEditSchema = z
  .object({
    id: ReleaseIdSchema,
    route: HarnessImprovementRouteSchema,
    operation: z.enum(["create", "update", "delete"]),
    target: z.string().trim().min(1).max(2_000),
    summary: z.string().trim().min(1).max(2_000),
    content: z.string().max(1_000_000).nullable(),
    contentHash: ReleaseHashSchema.nullable(),
    effects: z.array(HarnessChangeEffectSchema).min(1).max(20),
  })
  .strict()
  .superRefine((edit, context) => {
    if (edit.operation === "delete") {
      if (edit.content !== null || edit.contentHash !== null) {
        context.addIssue({
          code: "custom",
          message: "delete edits cannot include replacement content",
          path: ["content"],
        });
      }
      return;
    }
    if (edit.content === null || edit.contentHash === null) {
      context.addIssue({
        code: "custom",
        message: "create and update edits require content and contentHash",
        path: ["content"],
      });
      return;
    }
    const expected = contentHash(edit.content);
    if (edit.contentHash !== expected) {
      context.addIssue({
        code: "custom",
        message: `edit contentHash is ${edit.contentHash}; expected ${expected}`,
        path: ["contentHash"],
      });
    }
  });

export const HarnessWorkspaceRevisionRefSchema = z
  .object({
    workspaceId: ReleaseIdSchema,
    revision: RevisionSchema,
    sourceRevision: z.string().trim().min(1).max(500),
    channelRevision: RevisionSchema,
  })
  .strict();

export const HarnessOverlaySnapshotRefSchema = z
  .object({
    id: ReleaseIdSchema,
    revision: RevisionSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const HarnessTurnSnapshotSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessTurnSnapshot.v1"),
    workspaceId: ReleaseIdSchema,
    workspaceRevision: RevisionSchema,
    sourceRevision: z.string().trim().min(1).max(500),
    channelName: ReleaseIdSchema,
    channelRevision: RevisionSchema,
    harnessRelease: ImmutableReleaseRefSchema,
    overlay: HarnessOverlaySnapshotRefSchema.nullable().optional().default(null),
  })
  .strict();

export const HarnessRunOverlayContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRunOverlay.v1"),
    id: ReleaseIdSchema,
    runId: ReleaseIdSchema,
    baseHarnessRelease: ImmutableReleaseRefSchema,
    workspace: HarnessWorkspaceRevisionRefSchema,
    revision: RevisionSchema,
    status: z.enum(["active", "frozen", "abandoned"]),
    edits: z.array(HarnessOverlayEditSchema).max(1_000),
    createdAt: ReleaseTimestampSchema,
    updatedAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict();

export const HarnessRunOverlaySchema = HarnessRunOverlayContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export const HarnessProposalEvidenceRefSchema = z
  .object({
    kind: z.enum([
      "tool_event",
      "recovery",
      "validation",
      "user_turn",
      "work_output",
      "work_receipt",
    ]),
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema.nullable(),
  })
  .strict();

export const HarnessValidationPlanItemSchema = z
  .object({
    id: ReleaseIdSchema,
    kind: z.enum([
      "dependency",
      "schema",
      "package",
      "file_render",
      "skill",
      "prompt",
      "business_formula",
      "targeted_evaluation",
      "observed_recovery",
      "memory",
      "component_activation",
    ]),
    description: BoundedTextSchema,
    required: z.boolean(),
  })
  .strict();

export const HarnessImprovementProposalContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessImprovementProposal.v1"),
    id: ReleaseIdSchema,
    overlay: HarnessOverlaySnapshotRefSchema,
    baseHarnessRelease: ImmutableReleaseRefSchema,
    expectedWorkspace: HarnessWorkspaceRevisionRefSchema,
    requestedScope: z.enum(["personal", "team", "global"]),
    route: HarnessImprovementRouteSchema,
    risk: z.enum(["low", "review", "restricted"]),
    effects: z.array(HarnessChangeEffectSchema).min(1).max(20),
    evidence: z.array(HarnessProposalEvidenceRefSchema).min(1).max(1_000),
    edits: z.array(HarnessOverlayEditSchema).min(1).max(1_000),
    validationPlan: z.array(HarnessValidationPlanItemSchema).min(1).max(100),
    expectedOutcome: BoundedTextSchema,
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    const declaredEffects = new Set(proposal.effects);
    for (const [index, edit] of proposal.edits.entries()) {
      if (edit.route !== proposal.route) {
        context.addIssue({
          code: "custom",
          message: "every edit route must match the proposal route",
          path: ["edits", index, "route"],
        });
      }
      for (const effect of edit.effects) {
        if (!declaredEffects.has(effect)) {
          context.addIssue({
            code: "custom",
            message: `edit effect ${effect} is missing from proposal effects`,
            path: ["edits", index, "effects"],
          });
        }
      }
    }
    if (new Set(proposal.validationPlan.map((item) => item.id)).size !== proposal.validationPlan.length) {
      context.addIssue({
        code: "custom",
        message: "validation plan ids must be unique",
        path: ["validationPlan"],
      });
    }
  });

export const HarnessImprovementProposalSchema =
  HarnessImprovementProposalContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessTargetedValidationReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessTargetedValidationReceipt.v1"),
    id: ReleaseIdSchema,
    proposal: ImmutableReleaseRefSchema,
    validationId: ReleaseIdSchema,
    kind: HarnessValidationPlanItemSchema.shape.kind,
    status: z.enum(["passed", "failed", "blocked", "skipped"]),
    summary: BoundedTextSchema,
    evidenceRefs: z.array(HarnessProposalEvidenceRefSchema).max(1_000),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict();

export const HarnessTargetedValidationReceiptSchema =
  HarnessTargetedValidationReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessAdvanceDecisionSchema = z.enum([
  "advanced",
  "retained",
  "conflict",
  "rolled_back",
]);

export const HarnessAdvanceReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessAdvanceReceipt.v1"),
    id: ReleaseIdSchema,
    workspaceId: ReleaseIdSchema,
    ownerScope: HarnessOwnerScopeSchema,
    proposal: ImmutableReleaseRefSchema.nullable(),
    expectedWorkspaceRevision: RevisionSchema,
    observedWorkspaceRevision: RevisionSchema,
    previousChannelRevision: RevisionSchema,
    nextChannelRevision: RevisionSchema,
    previousRelease: ImmutableReleaseRefSchema.nullable(),
    nextRelease: ImmutableReleaseRefSchema.nullable(),
    validationReceipts: z.array(ImmutableReleaseRefSchema).max(100),
    decision: HarnessAdvanceDecisionSchema,
    reason: BoundedTextSchema,
    rollbackOf: ImmutableReleaseRefSchema.nullable(),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const changed = receipt.nextChannelRevision === receipt.previousChannelRevision + 1;
    if (["advanced", "rolled_back"].includes(receipt.decision) !== changed) {
      context.addIssue({
        code: "custom",
        message: "only successful advancement or rollback increments the channel revision",
        path: ["nextChannelRevision"],
      });
    }
    if (receipt.decision === "rolled_back" && receipt.rollbackOf === null) {
      context.addIssue({
        code: "custom",
        message: "rollback receipts require rollbackOf",
        path: ["rollbackOf"],
      });
    }
    if (receipt.decision !== "rolled_back" && receipt.rollbackOf !== null) {
      context.addIssue({
        code: "custom",
        message: "rollbackOf is only valid for rollback receipts",
        path: ["rollbackOf"],
      });
    }
  });

export const HarnessAdvanceReceiptSchema = HarnessAdvanceReceiptContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export const HarnessOverlayMergeReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessOverlayMergeReceipt.v1"),
    id: ReleaseIdSchema,
    workspaceId: ReleaseIdSchema,
    baseHarnessRelease: ImmutableReleaseRefSchema,
    leftOverlay: HarnessOverlaySnapshotRefSchema,
    rightOverlay: HarnessOverlaySnapshotRefSchema,
    decision: z.enum(["merged", "conflict"]),
    mergedOverlay: HarnessOverlaySnapshotRefSchema.nullable(),
    conflictTargets: z.array(z.string().trim().min(1).max(2_000)).max(1_000),
    requiresRevalidation: z.literal(true),
    createdAt: ReleaseTimestampSchema,
    metadata: MetadataSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if ((receipt.decision === "merged") !== (receipt.mergedOverlay !== null)) {
      context.addIssue({
        code: "custom",
        message: "merged decisions require a merged overlay; conflicts cannot provide one",
        path: ["mergedOverlay"],
      });
    }
    if ((receipt.decision === "conflict") !== (receipt.conflictTargets.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "conflict decisions require conflict targets and merged decisions cannot include them",
        path: ["conflictTargets"],
      });
    }
  });

export const HarnessOverlayMergeReceiptSchema =
  HarnessOverlayMergeReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export function createHarnessRunOverlay(
  content: z.input<typeof HarnessRunOverlayContentSchema>,
): HarnessRunOverlay {
  const parsed = HarnessRunOverlayContentSchema.parse(content);
  return HarnessRunOverlaySchema.parse({ ...parsed, contentHash: contentHash(parsed) });
}

export function createHarnessImprovementProposal(
  content: z.input<typeof HarnessImprovementProposalContentSchema>,
): HarnessImprovementProposal {
  const parsed = HarnessImprovementProposalContentSchema.parse(content);
  return HarnessImprovementProposalSchema.parse({
    ...parsed,
    contentHash: contentHash(parsed),
  });
}

export function createHarnessTargetedValidationReceipt(
  content: z.input<typeof HarnessTargetedValidationReceiptContentSchema>,
): HarnessTargetedValidationReceipt {
  const parsed = HarnessTargetedValidationReceiptContentSchema.parse(content);
  return HarnessTargetedValidationReceiptSchema.parse({
    ...parsed,
    contentHash: contentHash(parsed),
  });
}

export function createHarnessAdvanceReceipt(
  content: z.input<typeof HarnessAdvanceReceiptContentSchema>,
): HarnessAdvanceReceipt {
  const parsed = HarnessAdvanceReceiptContentSchema.parse(content);
  return HarnessAdvanceReceiptSchema.parse({
    ...parsed,
    contentHash: contentHash(parsed),
  });
}

export function createHarnessOverlayMergeReceipt(
  content: z.input<typeof HarnessOverlayMergeReceiptContentSchema>,
): HarnessOverlayMergeReceipt {
  const parsed = HarnessOverlayMergeReceiptContentSchema.parse(content);
  return HarnessOverlayMergeReceiptSchema.parse({
    ...parsed,
    contentHash: contentHash(parsed),
  });
}

export type HarnessOwnerScope = z.infer<typeof HarnessOwnerScopeSchema>;
export type HarnessCurrentChannel = z.infer<typeof HarnessCurrentChannelSchema>;
export type HarnessWorkspace = z.infer<typeof HarnessWorkspaceSchema>;
export type HarnessImprovementRoute = z.infer<typeof HarnessImprovementRouteSchema>;
export type HarnessChangeEffect = z.infer<typeof HarnessChangeEffectSchema>;
export type HarnessOverlayEdit = z.infer<typeof HarnessOverlayEditSchema>;
export type HarnessWorkspaceRevisionRef = z.infer<typeof HarnessWorkspaceRevisionRefSchema>;
export type HarnessTurnSnapshot = z.infer<typeof HarnessTurnSnapshotSchema>;
export type HarnessOverlaySnapshotRef = z.infer<typeof HarnessOverlaySnapshotRefSchema>;
export type HarnessRunOverlay = z.infer<typeof HarnessRunOverlaySchema>;
export type HarnessImprovementProposal = z.infer<typeof HarnessImprovementProposalSchema>;
export type HarnessTargetedValidationReceipt = z.infer<typeof HarnessTargetedValidationReceiptSchema>;
export type HarnessAdvanceDecision = z.infer<typeof HarnessAdvanceDecisionSchema>;
export type HarnessAdvanceReceipt = z.infer<typeof HarnessAdvanceReceiptSchema>;
export type HarnessOverlayMergeReceipt = z.infer<typeof HarnessOverlayMergeReceiptSchema>;
