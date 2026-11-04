import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";
import { ModelProjectBaseModelSchema } from "./model-projects.js";

const Id = z.string().trim().min(1).max(500), Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Source validation identifies a runtime reviewed for a staging trial;
 * GPU qualification requires a retained run of the exact model and runtime.
 * Neither observation is a reservation, funding approval or quality claim. */
export const ModelModificationValidationLevelSchema = z.enum(["source_validated", "gpu_qualified"]);
export type ModelModificationValidationLevel = z.infer<typeof ModelModificationValidationLevelSchema>;
export function assertModelModificationValidationLevel(
  execution: { state: "ready" | "unavailable" },
  validationLevel: ModelModificationValidationLevel | null,
) {
  if ((execution.state === "ready") !== (validationLevel !== null))
    throw new OpenPondProtocolError("model_modification_validation_mismatch", "Runtime validation must describe the observed executable runtime.");
}
export const ModelModificationMethodSchema = z.enum(["neuron_steering", "inspect_activations"]);
export const ModelModificationCapabilitiesQuerySchema = z.object({
  teamId: Id, modelId: ModelProjectBaseModelSchema.shape.modelId, source: ModelProjectBaseModelSchema.shape.source,
  revision: ModelProjectBaseModelSchema.shape.revision.unwrap().optional(),
  tokenizerRevision: ModelProjectBaseModelSchema.shape.tokenizerRevision.unwrap().optional(),
  chatTemplateHash: ModelProjectBaseModelSchema.shape.chatTemplateHash.unwrap().optional(),
  modelAssetId: ModelProjectBaseModelSchema.shape.modelAssetId.unwrap().optional(),
}).strict();
export type ModelModificationCapabilitiesQuery = z.infer<typeof ModelModificationCapabilitiesQuerySchema>;

export const ModelModificationExecutionCapabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable"), code: z.enum(["model_not_supported", "runtime_not_qualified"]),
    reason: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ state: z.literal("ready"), model: NeuronSteeringModelSchema,
    runtime: z.object({ id: Id, releaseHash: Hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      requestSchema: z.literal("openpond.activationReferenceRequest.v1"),
      evidence: z.object({ id: Id, contentHash: Hash }).strict(),
    }).strict(),
    limits: z.object({ maximumPrompts: z.number().int().positive().max(8), maximumPromptTokens: z.number().int().positive().max(4096),
      maximumVariants: z.number().int().positive().max(17), maximumCoordinates: z.number().int().positive().max(64),
      maximumNewTokens: z.number().int().nonnegative().max(128), maximumCapturedValues: z.number().int().positive().max(65_536),
      maximumForwardTokenWork: z.number().int().positive().max(1_000_000), maximumDurationSeconds: z.number().positive().max(300),
      maximumAbsoluteDose: z.number().finite().positive(),
    }).strict(),
  }).strict(),
]);
export type ModelModificationExecutionCapability = z.infer<typeof ModelModificationExecutionCapabilitySchema>;
export const ModelModificationCapabilitiesContentSchema = z.object({
  schemaVersion: z.literal("openpond.modelModificationCapabilities.v1"), teamId: Id, actorId: Id,
  query: ModelModificationCapabilitiesQuerySchema, requestHash: Hash,
  destination: z.literal("hosted"), checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  methods: z.array(z.object({ method: ModelModificationMethodSchema, draftSchema: z.literal("openpond.experimentDraft.v1"),
    validationLevel: ModelModificationValidationLevelSchema.nullable(),
    execution: ModelModificationExecutionCapabilitySchema,
  }).strict()).length(2),
}).strict().superRefine((value, ctx) => {
  if (value.teamId !== value.query.teamId || new Set(value.methods.map(row => row.method)).size !== 2)
    ctx.addIssue({ code: "custom", message: "Capabilities must retain one entry per method and the exact workspace." });
  for (const row of value.methods) if (row.execution.state === "ready" &&
      (value.query.source !== "managed" || value.query.modelAssetId !== undefined ||
       row.execution.model.modelId !== value.query.modelId || row.execution.model.revision !== value.query.revision || !value.query.tokenizerRevision))
    ctx.addIssue({ code: "custom", message: "An executable capability must bind this exact admitted managed base." });
});
export const ModelModificationCapabilitiesSchema = ModelModificationCapabilitiesContentSchema.safeExtend({ contentHash: Hash });
export type ModelModificationCapabilities = z.infer<typeof ModelModificationCapabilitiesSchema>;

/** A scoped observation, not an execution approval, reservation or worker claim. */
export async function parseAndVerifyModelModificationCapabilities(raw: unknown, rawQuery: ModelModificationCapabilitiesQuery, actorId?: string) {
  const query = ModelModificationCapabilitiesQuerySchema.parse(rawQuery), value = ModelModificationCapabilitiesSchema.parse(raw);
  for (const method of value.methods) assertModelModificationValidationLevel(method.execution, method.validationLevel);
  const { contentHash, ...content } = value;
  if (canonicalJson(value.query) !== canonicalJson(query) || value.requestHash !== await canonicalSha256(query)
      || value.teamId !== query.teamId || actorId !== undefined && value.actorId !== actorId
      || contentHash !== await canonicalSha256(content))
    throw new OpenPondProtocolError("model_modification_capability_mismatch", "Capabilities returned a different model, account or retained observation.");
  const checked = Date.parse(value.checkedAt), expiry = Date.parse(value.expiresAt);
  if (checked > Date.now() + 30_000 || expiry <= Date.now() || expiry <= checked || expiry - checked > 300_000)
    throw new OpenPondProtocolError("model_modification_capability_expired", "Refresh model capabilities before preparing execution.");
  return value;
}

export function createModelModificationCapabilitiesClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return { async modificationCapabilities(raw: ModelModificationCapabilitiesQuery, options?: { signal?: AbortSignal }): Promise<ModelModificationCapabilities> {
    const query = ModelModificationCapabilitiesQuerySchema.parse(raw);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
    const timeout = AbortSignal.timeout(30_000);
    return parseAndVerifyModelModificationCapabilities(await request(`/v1/training/modification-capabilities?${params}`, {
      signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    }), query);
  } };
}
