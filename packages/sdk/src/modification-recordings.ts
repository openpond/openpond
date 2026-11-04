import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ActivationReferenceRequestSchema, ActivationReferenceResultSchema, parseAndVerifyActivationReferenceRequest, parseAndVerifyActivationReferenceResult } from "./activation-reference.js";
import { ModelModificationMethodSchema } from "./model-modification-capabilities.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MODIFICATION_RECORDING_MAX_BYTES = 8_388_608;
export const ModificationRecordingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.modificationRecordingRequest.v1"), teamId: Id, operationId: Id,
  name: z.string().trim().min(1).max(500), projectId: Id.nullable(), method: ModelModificationMethodSchema,
  request: ActivationReferenceRequestSchema, result: ActivationReferenceResultSchema,
}).strict();
export type ModificationRecordingRequest = z.infer<typeof ModificationRecordingRequestSchema>;
export const ModificationRecordingContentSchema = z.object({
  schemaVersion: z.literal("openpond.modificationRecording.v1"), id: Id, teamId: Id, actorId: Id, operationId: Id,
  commandHash: Hash, name: z.string().trim().min(1).max(500), projectId: Id.nullable(), method: ModelModificationMethodSchema,
  accountScopeHash: Hash,
  custody: z.literal("local"), provenance: z.literal("external_observation"), measurementAttestation: z.literal("unattested"),
  model: ActivationReferenceRequestSchema.shape.model, inputHash: Hash, resultHash: Hash,
  artifact: z.object({ contentHash: Hash, sizeBytes: z.number().int().positive().max(MODIFICATION_RECORDING_MAX_BYTES) }).strict(),
  counts: z.object({ prompts: z.number().int().positive().max(8), variants: z.number().int().positive().max(17),
    outcomes: z.number().int().positive().max(136), captures: z.number().int().nonnegative().max(32_768) }).strict(),
  createdAt: z.iso.datetime(),
}).strict();
export const ModificationRecordingSchema = ModificationRecordingContentSchema.extend({ contentHash: Hash }).strict();
export type ModificationRecording = z.infer<typeof ModificationRecordingSchema>;
export const ModificationRecordingDocumentSchema = z.object({ request: ActivationReferenceRequestSchema, result: ActivationReferenceResultSchema }).strict();
export const ModificationRecordingReadSchema = z.object({ recording: ModificationRecordingSchema, document: ModificationRecordingDocumentSchema }).strict();
export const ModificationRecordingReadQuerySchema = z.object({ teamId: Id }).strict();
export const ModificationRecordingListQuerySchema = z.object({ teamId: Id, projectId: Id.optional(),
  search: z.string().trim().max(1000).optional(), cursor: z.string().min(1).max(2000).optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export type ModificationRecordingListQuery = z.input<typeof ModificationRecordingListQuerySchema>;
export const ModificationRecordingPageSchema = z.object({ teamId: Id, actorId: Id, accountScopeHash: Hash, projectId: Id.nullable(),
  items: z.array(ModificationRecordingSchema).max(100), nextCursor: z.string().min(1).max(2000).nullable() }).strict();

export async function verifyModificationRecordingRequest(raw: unknown) {
  const value = ModificationRecordingRequestSchema.parse(raw);
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > MODIFICATION_RECORDING_MAX_BYTES)
    throw new OpenPondProtocolError("modification_recording_too_large", "The recording exceeds 8 MiB.");
  const request = await parseAndVerifyActivationReferenceRequest(value.request);
  await parseAndVerifyActivationReferenceResult(value.result, request);
  const profiles = request.variants.filter(row => row.profile !== null).length;
  if (value.method === "inspect_activations" ? profiles > 0 : profiles === 0 || profiles === request.variants.length)
    throw new OpenPondProtocolError("modification_recording_method_mismatch", "Inspection must be unsteered; a steering comparison needs an explicit Off baseline and intervention.");
  return value;
}
export async function verifyModificationRecording(raw: unknown, teamId?: string, actorId?: string) {
  const value = ModificationRecordingSchema.parse(raw), { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content) || teamId !== undefined && value.teamId !== teamId || actorId !== undefined && value.actorId !== actorId
      || value.id !== `observation-${await canonicalSha256({ scope: value.accountScopeHash, operationId: value.operationId })}`
      || value.counts.outcomes !== value.counts.prompts * value.counts.variants)
    throw new OpenPondProtocolError("modification_recording_scope_mismatch", "The retained recording differs from its owner or immutable metadata.");
  return value;
}
export async function verifyModificationRecordingRead(raw: unknown, teamId?: string, actorId?: string) {
  const value = ModificationRecordingReadSchema.parse(raw), recording = await verifyModificationRecording(value.recording, teamId, actorId);
  const command = await verifyModificationRecordingRequest({ schemaVersion: "openpond.modificationRecordingRequest.v1", teamId: recording.teamId,
    operationId: recording.operationId, name: recording.name, projectId: recording.projectId, method: recording.method, ...value.document });
  const sizeBytes = new TextEncoder().encode(canonicalJson(value.document)).byteLength;
  if (recording.commandHash !== await canonicalSha256(command) || recording.artifact.contentHash !== await canonicalSha256(value.document)
      || recording.artifact.sizeBytes !== sizeBytes || recording.inputHash !== await canonicalSha256(value.document.request)
      || recording.resultHash !== value.document.result.contentHash || canonicalJson(recording.model) !== canonicalJson(command.request.model)
      || recording.counts.prompts !== command.request.prompts.length || recording.counts.variants !== command.request.variants.length
      || recording.counts.outcomes !== command.result.outcomes.length || recording.counts.captures !== command.result.captures.length)
    throw new OpenPondProtocolError("modification_recording_artifact_mismatch", "The retained observation differs from its request, output or capture inventory.");
  return { ...value, recording };
}
export function createModificationRecordingsClient(request: (path: string, init?: RequestInit, responseLimit?: number) => Promise<unknown>) {
  return {
    async recordModificationObservation(raw: ModificationRecordingRequest) {
      const command = await verifyModificationRecordingRequest(raw);
      const value = await verifyModificationRecording(await request("/v1/modification-recordings", { method: "POST", body: canonicalJson(command) }), command.teamId);
      if (value.commandHash !== await canonicalSha256(command) || value.operationId !== command.operationId)
        throw new OpenPondProtocolError("modification_recording_request_mismatch", "The service retained another observation.");
      return value;
    },
    async modificationRecording(id: string, query: { teamId: string }) {
      const identity = Id.parse(id), teamId = Id.parse(query.teamId);
      const value = await verifyModificationRecordingRead(await request(`/v1/modification-recordings/${encodeURIComponent(identity)}?${new URLSearchParams({ teamId })}`, undefined,
        MODIFICATION_RECORDING_MAX_BYTES + 65_536), teamId);
      if (value.recording.id !== identity) throw new OpenPondProtocolError("modification_recording_scope_mismatch", "The service returned another recording.");
      return value;
    },
    async modificationRecordings(raw: ModificationRecordingListQuery) {
      const query = ModificationRecordingListQuerySchema.parse(raw), params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const page = ModificationRecordingPageSchema.parse(await request(`/v1/modification-recordings?${params}`));
      if (page.teamId !== query.teamId || page.projectId !== (query.projectId ?? null) || page.items.length > query.limit
          || new Set(page.items.map(row => row.id)).size !== page.items.length || query.cursor && page.nextCursor === query.cursor)
        throw new OpenPondProtocolError("modification_recording_scope_mismatch", "The recording list returned another scope or page.");
      for (const row of page.items) {
        await verifyModificationRecording(row, query.teamId, page.actorId);
        if (row.accountScopeHash !== page.accountScopeHash || query.projectId && row.projectId !== query.projectId)
          throw new OpenPondProtocolError("modification_recording_scope_mismatch", "The recording list returned another Project.");
      }
      return page;
    },
  };
}
