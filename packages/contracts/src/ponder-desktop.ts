import { z } from "zod";
import { PonderDesktopSourceSchema, PonderDesktopWorkflowStepSchema } from "./ponder-desktop-workflow.js";

/** Signed original-desktop evidence of a reserved session with no accepted input or turn. */
export const PonderDesktopReservationResumeSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    creationHash: z.string().regex(/^[a-f0-9]{64}$/),
    sessionRevision: z.string().regex(/^[a-f0-9]{64}$/),
    executionRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PonderDesktopReservationResume = z.infer<typeof PonderDesktopReservationResumeSchema>;

// Wire contract mirrored in Native packages/contracts/src/ponder-desktop.ts.
const id = z.string().trim().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const PONDER_DESKTOP_RENEW_MS = 15_000;
export const PONDER_DESKTOP_OFFLINE_MS = 60_000;
export const PONDER_DESKTOP_INTERACTIVE_TTL_MS = 5 * 60_000;

export const PonderDesktopScopeSchema = z
  .object({
    installationId: z.string().uuid(),
    profileId: id,
    ownerUserId: id,
    teamId: id,
    bindingId: id,
    bindingRevision: z.number().int().positive(),
  })
  .strict();
export type PonderDesktopScope = z.infer<typeof PonderDesktopScopeSchema>;

export const PonderDesktopProofSchema = z
  .object({
    version: z.literal(1),
    scope: PonderDesktopScopeSchema,
    epoch: z.string().uuid().nullable(),
    runtimeId: z.string().uuid(),
    audience: z.string().url(),
    nonce: z.string().uuid(),
    issuedAt: z.string().datetime(),
    payloadHash: hash,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type PonderDesktopProof = z.infer<typeof PonderDesktopProofSchema>;

/** Sign this array, never a loosely reconstructed prompt or display label. */
export function ponderDesktopProofMessage(proof: Omit<PonderDesktopProof, "signature">): string {
  return JSON.stringify([
    proof.version,
    proof.scope.installationId,
    proof.scope.profileId,
    proof.scope.ownerUserId,
    proof.scope.teamId,
    proof.scope.bindingId,
    proof.scope.bindingRevision,
    proof.epoch,
    proof.runtimeId,
    proof.audience,
    proof.nonce,
    proof.issuedAt,
    proof.payloadHash,
  ]);
}

/** Method/path and recursively canonical JSON bind the proof to one API action. */
export { canonicalRequestContent as ponderDesktopRequestContent } from "./canonical-request-content.js";

export const PonderDesktopTargetSchema = z
  .object({
    id,
    kind: z.enum(["session", "starter"]),
    title: z.string().trim().min(1).max(300),
    providerId: id,
    modelId: z.string().trim().min(1).max(300).nullable(),
    experience: z.enum(["chat", "work"]),
    workspaceId: id,
    workspaceLabel: z.string().trim().min(1).max(300),
    profileSelectionId: id.nullable(),
    revision: hash,
    available: z.boolean(),
    unavailableReason: z.string().max(500).nullable(),
    canMessage: z.boolean(),
    canSteer: z.boolean(),
    canStop: z.boolean(),
    activeTurnId: id.nullable(),
  })
  .strict();
export type PonderDesktopTarget = z.infer<typeof PonderDesktopTargetSchema>;

export const PONDER_DESKTOP_CATALOG_MAX_TARGETS = 20_000;
export const PonderDesktopCatalogSchema = z
  .object({
    revision: hash,
    capturedAt: z.string().datetime(),
    targets: z.array(PonderDesktopTargetSchema).max(PONDER_DESKTOP_CATALOG_MAX_TARGETS),
  })
  .strict();
export type PonderDesktopCatalog = z.infer<typeof PonderDesktopCatalogSchema>;

/** Internal captures are published in immutable, bounded pages before lease renewal. */
export const PONDER_DESKTOP_CATALOG_PAGE_SIZE = 100;
export const PonderDesktopCatalogManifestSchema = z
  .object({
    revision: hash,
    capturedAt: z.string().datetime(),
    targetCount: z.number().int().min(0).max(PONDER_DESKTOP_CATALOG_MAX_TARGETS),
    pageCount: z.number().int().min(0).max(200),
  })
  .strict()
  .refine(
    (value) => value.pageCount === Math.ceil(value.targetCount / PONDER_DESKTOP_CATALOG_PAGE_SIZE),
    {
      message: "ponder_desktop_catalog_page_count_invalid",
    },
  );
export type PonderDesktopCatalogManifest = z.infer<typeof PonderDesktopCatalogManifestSchema>;
export const PonderDesktopCatalogPageSchema = z
  .object({
    catalog: PonderDesktopCatalogManifestSchema,
    index: z.number().int().min(0).max(199),
    targets: PonderDesktopTargetSchema.array().min(1).max(PONDER_DESKTOP_CATALOG_PAGE_SIZE),
  })
  .strict()
  .refine(
    (value) =>
      value.index < value.catalog.pageCount &&
      value.targets.length ===
        Math.min(
          PONDER_DESKTOP_CATALOG_PAGE_SIZE,
          value.catalog.targetCount - value.index * PONDER_DESKTOP_CATALOG_PAGE_SIZE,
        ),
    { message: "ponder_desktop_catalog_page_size_invalid" },
  );
export const PonderDesktopCatalogCursorSchema = z
  .object({
    revision: hash,
    pageIndex: z.number().int().min(0).max(199),
  })
  .strict();
export type PonderDesktopCatalogCursor = z.infer<typeof PonderDesktopCatalogCursorSchema>;

export const PonderDesktopAttachmentSchema = z
  .object({
    scope: PonderDesktopScopeSchema,
    publicKey: z.string().min(1).max(512),
    runtimeId: z.string().uuid(),
    epoch: z.string().uuid(),
    authorizationRevision: z.number().int().positive(),
    reauthorizationGeneration: z.number().int().nonnegative().default(0),
    state: z.enum(["attached", "revoked"]),
    leaseExpiresAt: z.string().datetime(),
    catalog: PonderDesktopCatalogManifestSchema.nullable(),
  })
  .strict();
export type PonderDesktopAttachment = z.infer<typeof PonderDesktopAttachmentSchema>;

const intentBase = {
  targetId: id,
  targetRevision: hash,
};
const prompt = z.string().trim().min(1).max(32_000);
export const PonderDesktopIntentSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...intentBase,
      action: z.literal("create"),
      prompt,
      title: z.string().trim().min(1).max(300),
    })
    .strict(),
  z.object({ ...intentBase, action: z.literal("message"), prompt }).strict(),
  z
    .object({
      ...intentBase,
      action: z.literal("steer"),
      prompt,
      expectedTurnId: id,
    })
    .strict(),
  z.object({ ...intentBase, action: z.literal("stop"), expectedTurnId: id }).strict(),
  z.object({ ...intentBase, action: z.literal("observe"), expectedTurnId: id }).strict(),
  z.object({ ...intentBase, action: z.literal("inspect"), expectedTurnId: id }).strict(),
]);
export type PonderDesktopIntent = z.infer<typeof PonderDesktopIntentSchema>;

export const PonderDesktopOriginSchema = z
  .object({
    scope: PonderDesktopScopeSchema,
    epoch: z.string().uuid(),
    originChatTurnId: id,
    originToolCallId: id,
    humanControlId: id.optional(),
    authorizationRevision: z.number().int().positive(),
  })
  .strict();
export type PonderDesktopOrigin = z.infer<typeof PonderDesktopOriginSchema>;

export const PonderDesktopTurnAdmissionSchema = z
  .object({
    scope: PonderDesktopScopeSchema,
    epoch: z.string().uuid(),
    runtimeId: z.string().uuid(),
    authorizationRevision: z.number().int().positive(),
  })
  .strict();
export type PonderDesktopTurnAdmission = z.infer<typeof PonderDesktopTurnAdmissionSchema>;

export const PonderDesktopOperationSchema = z
  .object({
    id,
    origin: PonderDesktopOriginSchema,
    payloadHash: hash,
    intent: PonderDesktopIntentSchema,
    target: PonderDesktopTargetSchema,
    workflow: PonderDesktopWorkflowStepSchema.optional(),
    state: z.enum([
      "ready",
      "dispatching",
      "admitted",
      "completed",
      "failed",
      "cancelled",
      "expired",
      "attention",
    ]),
    claimId: z.string().uuid().nullable(),
    claimedEpoch: z.string().uuid().nullable(),
    expiresAt: z.string().datetime(),
    admittedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    receipt: z
      .object({
        sessionId: id,
        sessionTitle: z.string().min(1).max(300),
        inputId: id.nullable(),
        turnId: id.nullable(),
        state: id,
      })
      .strict()
      .nullable(),
    error: z.string().max(1_000).nullable(),
  })
  .strict();
export type PonderDesktopOperation = z.infer<typeof PonderDesktopOperationSchema>;

/** Committed local output retains local identity; it is never a hosted turn/file. */
export const PonderDesktopResultSchema = z
  .object({
    operationId: id,
    payloadHash: hash,
    sessionId: id,
    sessionTitle: z.string().min(1).max(300),
    inputId: id.nullable(),
    turnId: id,
    completedAt: z.string().datetime(),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    body: z.string().max(128_000),
    bodyTruncated: z.boolean(),
    assistantEventIds: z.array(id).max(2_000),
    providerId: id,
    modelId: id.nullable(),
    workspaceId: id,
    outputs: z
      .array(
        z
          .object({
            id,
            title: z.string().min(1).max(300),
            contentType: id,
            sizeBytes: z.number().int().nonnegative(),
            sha256: hash,
          })
          .strict(),
      )
      .max(100),
    error: z.string().max(2_000).nullable(),
    source: PonderDesktopSourceSchema.optional(),
    sourceError: z.string().max(1_000).optional(),
  })
  .strict();
export type PonderDesktopResult = z.infer<typeof PonderDesktopResultSchema>;

/** Bind derived workflow context into the signed operation without changing ordinary task identities. */
export function ponderDesktopOperationContent(operation: Pick<PonderDesktopOperation, "origin" | "intent" | "target" | "workflow">) {
  return { origin: operation.origin, intent: operation.intent, target: operation.target,
    ...(operation.workflow ? { workflow: operation.workflow } : {}) };
}

export const PonderLocalMessagePresentationSchema = z
  .object({
    version: z.literal(1),
    direction: z.enum(["sent", "received"]),
    operationId: id,
    installationId: z.string().uuid(),
    profileId: id,
    ownerUserId: id,
    teamId: id,
    sessionId: id,
    title: z.string().min(1).max(300),
    turnId: id.nullable(),
    receiptId: id,
    status: id,
    body: z.string(),
    outputs: PonderDesktopResultSchema.shape.outputs,
  })
  .strict();
export type PonderLocalMessagePresentation = z.infer<typeof PonderLocalMessagePresentationSchema>;
