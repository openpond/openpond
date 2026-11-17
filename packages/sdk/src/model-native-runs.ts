import { z } from "zod";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
const Cursor = z.string().trim().min(1).max(2048);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ModelRunModelRefSchema = z.object({ id: Id, revision: z.number().int().positive(), etag: Hash }).strict();
export const ModelRunExecutionRefSchema = z.object({ id: Id, revision: z.number().int().positive(), planHash: Hash }).strict();
export const ModelRunBindingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.modelRunBinding.v1"), operationId: Id, teamId: Id,
  model: ModelRunModelRefSchema, execution: ModelRunExecutionRefSchema,
}).strict();
export type ModelRunBindingRequest = z.infer<typeof ModelRunBindingRequestSchema>;
export const ModelRunBindingSchema = z.object({
  model: ModelRunModelRefSchema, execution: ModelRunExecutionRefSchema,
  method: Id, baseModelHash: Hash, createdAt: z.iso.datetime(),
}).strict();
export const ModelRunBindingReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.modelRunBindingReceipt.v1"), teamId: Id, actorId: Id,
  operationId: Id, requestHash: Hash, binding: ModelRunBindingSchema,
}).strict();
export const ModelRunBindingReceiptSchema = ModelRunBindingReceiptContentSchema.extend({ contentHash: Hash }).strict();
export type ModelRunBindingReceipt = z.infer<typeof ModelRunBindingReceiptSchema>;
export async function parseAndVerifyModelRunBindingReceipt(raw: unknown, request?: ModelRunBindingRequest) {
  const value = ModelRunBindingReceiptSchema.parse(raw), { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content) || request && (
    value.teamId !== request.teamId || value.operationId !== request.operationId || value.requestHash !== await canonicalSha256(request)
    || await canonicalSha256(value.binding.model) !== await canonicalSha256(request.model)
    || await canonicalSha256(value.binding.execution) !== await canonicalSha256(request.execution)
  )) throw new OpenPondProtocolError("model_run_binding_mismatch", "The Model/run binding differs from its original reviewed identities.");
  return value;
}
export const ModelNativeRunSchema = z.object({
  kind: z.literal("modification"),
  id: Id, modelProjectId: Id, name: z.string(), method: Id, phase: Id, projectId: Id.nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), resultRecordedAt: z.iso.datetime().nullable(),
  planHash: Hash, modelRevision: z.number().int().positive().nullable(), versionHashes: z.array(Hash),
}).strict();
export const ModelNativeRunPageSchema = z.object({
  schemaVersion: z.literal("openpond.modelNativeRunPage.v1"), teamId: Id, modelProjectId: Id,
  items: z.array(ModelNativeRunSchema).max(100), total: z.number().int().nonnegative(), nextCursor: Cursor.nullable(),
}).strict();
export type ModelNativeRunPage = z.infer<typeof ModelNativeRunPageSchema>;

/** Reject foreign or inconsistent pages before they enter a selected Model's cache. */
export function parseModelNativeRunPage(raw: unknown, scope: { modelProjectId: string; teamId: string; limit?: number; cursor?: string }) {
  const id = Id.parse(scope.modelProjectId), teamId = Id.parse(scope.teamId);
  const limit = z.number().int().min(1).max(100).parse(scope.limit ?? 25);
  const cursor = scope.cursor === undefined ? undefined : Cursor.parse(scope.cursor);
  const page = ModelNativeRunPageSchema.parse(raw);
  if (page.teamId !== teamId || page.modelProjectId !== id || page.items.length > limit
    || page.total < page.items.length || new Set(page.items.map(item => item.id)).size !== page.items.length
    || page.items.some(item => item.modelProjectId !== id) || cursor && page.nextCursor === cursor)
    throw new OpenPondProtocolError("model_native_runs_mismatch", "The Model run history returned another scope.");
  return page;
}

/** Model association is metadata. It never saves weights, starts compute or enables serving. */
export function createModelNativeRunClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async bindNativeRun(raw: ModelRunBindingRequest) {
      const input = ModelRunBindingRequestSchema.parse(raw);
      return parseAndVerifyModelRunBindingReceipt(await request("/v1/model-projects/configuration/bind-run", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input),
      }), input);
    },
    async nativeRuns(modelProjectId: string, options: { teamId: string; limit?: number; cursor?: string }) {
      const id = Id.parse(modelProjectId), teamId = Id.parse(options.teamId), limit = z.number().int().min(1).max(100).parse(options.limit ?? 25);
      const cursor = options.cursor === undefined ? undefined : Cursor.parse(options.cursor);
      const query = new URLSearchParams({ modelProjectId: id, limit: String(limit), ...(cursor ? { cursor } : {}) });
      return parseModelNativeRunPage(await request(`/v1/model-projects/configuration/native-runs?${query}`, { headers: { accept: "application/json" } }),
        { modelProjectId: id, teamId, limit, cursor });
    },
  };
}
