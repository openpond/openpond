import { activationStartingProfileSource } from "./steering-experiment-source.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ActivationExperimentFormDraftSchema } from "./activation-experiment-draft.js";
import { ActivationReferenceRequestSchema, parseAndVerifyActivationReferenceRequest } from "./activation-reference.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationMethodSchema } from "./model-modification-capabilities.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Bounded CPU compilation only. Runtime/tokenizer assets are host-owned. */
export const ManagedModificationCompileSchema = z.object({
  teamId: Id, projectId: Id.nullable(), method: ModelModificationMethodSchema,
  query: ModelModificationCapabilitiesQuerySchema, form: ActivationExperimentFormDraftSchema,
}).strict();
export type ManagedModificationCompile = z.infer<typeof ManagedModificationCompileSchema>;
export const ManagedModificationCompilationContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedModificationCompilation.v1"), teamId: Id, actorId: Id,
  projectId: Id.nullable(), method: ModelModificationMethodSchema, query: ModelModificationCapabilitiesQuerySchema,
  formHash: Hash, request: ActivationReferenceRequestSchema, inputHash: Hash,
}).strict();
export const ManagedModificationCompilationSchema = ManagedModificationCompilationContentSchema.extend({contentHash: Hash}).strict();
export type ManagedModificationCompilation = z.infer<typeof ManagedModificationCompilationSchema>;

export function parseManagedModificationCompile(raw: unknown) {
  const value = ManagedModificationCompileSchema.parse(raw), query = value.query;
  const source = {schemaVersion: "openpond.baseModelPreference.v1", modelId: query.modelId, source: query.source,
    revision: query.revision ?? null, tokenizerRevision: query.tokenizerRevision ?? null,
    chatTemplateHash: query.chatTemplateHash ?? null, modelAssetId: query.modelAssetId ?? null};
  if (value.form.startingProfile && value.method !== "neuron_steering")
    throw new OpenPondProtocolError("managed_modification_saved_source_unsupported", "Saved steering sources currently require neuron steering.");
  if (query.teamId !== value.teamId || canonicalJson(value.form.baseModel) !== canonicalJson(source))
    throw new OpenPondProtocolError("managed_modification_compile_scope_mismatch", "Retain the exact form, model and workspace query.");
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > 1_048_576)
    throw new OpenPondProtocolError("managed_modification_compile_too_large", "The bounded form exceeds 1 MiB.");
  return value;
}
/** Verifies the compiled request's exact input/model identity and complete
 * declared bounds. Compilation grants no runtime or funding authority. */
export async function parseAndVerifyManagedModificationCompilation(raw: unknown, input: ManagedModificationCompile) {
  const command = parseManagedModificationCompile(input), value = ManagedModificationCompilationSchema.parse(raw);
  const {contentHash, ...content} = value, request = await parseAndVerifyActivationReferenceRequest(value.request);
  if (canonicalJson(command.form.startingProfile ?? null) !== canonicalJson(request.startingProfile ? activationStartingProfileSource(request.startingProfile) : null))
    throw new OpenPondProtocolError("managed_modification_compilation_mismatch", "The compilation dropped or changed the saved steering source.");
  const profiles = request.variants.filter(row => row.profile !== null).length;
  if (contentHash !== await canonicalSha256(content) || value.teamId !== command.teamId || value.projectId !== command.projectId ||
      value.method !== command.method || canonicalJson(value.query) !== canonicalJson(command.query) ||
      value.formHash !== await canonicalSha256(command.form) || value.inputHash !== await canonicalSha256(request) ||
      request.model.modelId !== command.query.modelId || request.model.revision !== command.query.revision ||
      (command.method === "inspect_activations" ? profiles > 0 : profiles === 0 || profiles === request.variants.length))
    throw new OpenPondProtocolError("managed_modification_compilation_mismatch", "The compilation differs from the exact requested form, model or bounds.");
  return value;
}
