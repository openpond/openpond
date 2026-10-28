import { z } from "zod";
import { ToolLearningActionSchema } from "./actions.js";
import {
  TOOL_LEARNING_LIMITS,
  ToolLearningEnvironmentSchema,
  ToolLearningHashSchema as Hash,
  ToolLearningIdSchema as Id,
  ToolLearningRefSchema as Ref,
  ToolLearningScopeSchema,
  ToolLearningTimestampSchema as Timestamp,
  boundedToolLearningSchema,
  toolLearningContentHash,
  toolLearningText,
} from "./primitives.js";

export const ToolLearningCapabilitySchema = z
  .object({
    id: Id,
    application: z.string().min(1).max(200),
    versions: z.array(z.string().min(1).max(200)).min(1).max(32),
    tools: z.array(z.string().min(1).max(200)).min(1).max(32),
    mode: z.literal("recovery"),
    routingInstruction: toolLearningText(2000),
    qualification: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("integration"), receipt: Ref }).strict(),
      z
        .object({
          kind: z.literal("learned"),
          receipt: Ref,
          trainingRun: Ref,
          adapter: Ref,
          evaluation: Ref,
          activation: Ref,
        })
        .strict(),
    ]),
  })
  .strict();

const Manifest = z
  .object({
    schemaVersion: z.literal("openpond.toolLearningManifest.v1"),
    installationId: Id,
    scope: ToolLearningScopeSchema,
    revision: z.number().int().positive(),
    contentHash: Hash,
    issuedAt: Timestamp,
    expiresAt: Timestamp,
    modelRelease: Ref,
    responseSchema: z.literal("openpond.toolLearningDecision.v1"),
    capabilities: z.array(ToolLearningCapabilitySchema).max(TOOL_LEARNING_LIMITS.capabilities),
  })
  .strict()
  .superRefine((manifest, context) => {
    const { contentHash, ...body } = manifest;
    if (toolLearningContentHash(body) !== contentHash)
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "Manifest content hash mismatch.",
      });
    const lifetime = Date.parse(manifest.expiresAt) - Date.parse(manifest.issuedAt);
    if (lifetime <= 0 || lifetime > TOOL_LEARNING_LIMITS.manifestSeconds * 1000)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Manifest expiry exceeds the supported lifetime.",
      });
    if (
      new Set(manifest.capabilities.map((entry) => entry.id)).size !== manifest.capabilities.length
    )
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capability IDs must be unique.",
      });
  });
export const ToolLearningManifestSchema = boundedToolLearningSchema(
  Manifest,
  TOOL_LEARNING_LIMITS.consultationBytes,
);
export type ToolLearningManifest = z.infer<typeof ToolLearningManifestSchema>;

export const ToolLearningConsultationRequestSchema = boundedToolLearningSchema(
  z
    .object({
      schemaVersion: z.literal("openpond.toolLearningConsultation.v1"),
      operationId: Id,
      installationId: Id,
      scope: ToolLearningScopeSchema,
      sessionId: Id,
      callId: Id,
      capabilityId: Id,
      manifestHash: Hash,
      modelRelease: Ref,
      mode: z.literal("recovery"),
      intent: toolLearningText(2000),
      action: ToolLearningActionSchema,
      actionHash: Hash,
      environment: ToolLearningEnvironmentSchema,
      contextHash: Hash,
      failure: z
        .object({
          message: toolLearningText(TOOL_LEARNING_LIMITS.resultBytes),
          observation: Ref,
        })
        .strict(),
      round: z.number().int().min(1).max(TOOL_LEARNING_LIMITS.consultationRounds),
    })
    .strict()
    .superRefine((request, context) => {
      if (toolLearningContentHash(request.action) !== request.actionHash)
        context.addIssue({
          code: "custom",
          path: ["actionHash"],
          message: "Consultation action hash mismatch.",
        });
      if (
        toolLearningContentHash({
          intent: request.intent,
          environment: request.environment,
          failure: request.failure,
        }) !== request.contextHash
      )
        context.addIssue({
          code: "custom",
          path: ["contextHash"],
          message: "Consultation context hash mismatch.",
        });
    }),
  TOOL_LEARNING_LIMITS.consultationBytes,
);
export type ToolLearningConsultationRequest = z.infer<typeof ToolLearningConsultationRequestSchema>;

/** Only model-authored task content; transport failures never become proceed. */
export const ToolLearningDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("proceed") }).strict(),
  z
    .object({
      decision: z.literal("revise"),
      issues: z
        .array(
          z
            .object({
              category: z.string().min(1).max(120),
              feedback: toolLearningText(2000),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  z
    .object({
      decision: z.literal("needs_context"),
      missing: z
        .array(
          z
            .object({
              field: z.string().min(1).max(120),
              reason: toolLearningText(500),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
]);

const ResponseIdentity = {
  operationId: Id,
  installationId: Id,
  capabilityId: Id,
  manifestHash: Hash,
  modelRelease: Ref,
  actionHash: Hash,
  contextHash: Hash,
};
export const ToolLearningConsultationResponseSchema = boundedToolLearningSchema(
  z.discriminatedUnion("state", [
    z
      .object({
        schemaVersion: z.literal("openpond.toolLearningDecision.v1"),
        ...ResponseIdentity,
        state: z.literal("completed"),
        decision: ToolLearningDecisionSchema,
        usageReceipt: Ref,
        completedAt: Timestamp,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal("openpond.toolLearningDecision.v1"),
        ...ResponseIdentity,
        state: z.literal("unavailable"),
        reason: z.enum([
          "disabled",
          "revoked",
          "expired_manifest",
          "unsupported_scope",
          "budget_exhausted",
          "timeout",
          "invalid_output",
          "cancelled",
          "dispatch_uncertain",
        ]),
        usageReceipt: Ref.nullable(),
      })
      .strict(),
  ]),
  TOOL_LEARNING_LIMITS.consultationBytes,
);
export type ToolLearningConsultationResponse = z.infer<
  typeof ToolLearningConsultationResponseSchema
>;

/** Invoke before exposing a result to the agent; even valid JSON may be stale. */
export function assertToolLearningConsultationResponse(
  requestValue: unknown,
  responseValue: unknown,
): ToolLearningConsultationResponse {
  const request = ToolLearningConsultationRequestSchema.parse(requestValue);
  const response = ToolLearningConsultationResponseSchema.parse(responseValue);
  for (const key of [
    "operationId",
    "installationId",
    "capabilityId",
    "manifestHash",
    "actionHash",
    "contextHash",
  ] as const)
    if (request[key] !== response[key])
      throw new Error(`tool_learning_consultation_${key}_mismatch`);
  if (
    request.modelRelease.id !== response.modelRelease.id ||
    request.modelRelease.contentHash !== response.modelRelease.contentHash
  )
    throw new Error("tool_learning_consultation_model_mismatch");
  return response;
}
