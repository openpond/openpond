import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const EngramModuleReferenceSchema = z.object({id: Id, contentHash: Hash, payloadSha256: Hash}).strict();
export const SavedEngramModelSelectionSchema = z.object({modelProjectId: Id, versionHash: Hash}).strict();
/** An omitted switch inherits the retained serving default. Each request/KV
 * namespace pins one committed module, including when the switch is Off. */
export const EngramInferenceOptionsSchema = z.object({
  savedModel: SavedEngramModelSelectionSchema.optional(), engram: z.boolean().optional(),
}).strict();
export type EngramInferenceOptions = z.infer<typeof EngramInferenceOptionsSchema>;
export const ResolvedEngramSelectionSchema = z.object({
  schemaVersion: z.literal("openpond.resolvedEngramSelection.v1"),
  requested: z.enum(["inherit", "on", "off"]), savedModel: SavedEngramModelSelectionSchema,
  defaultEnabled: z.boolean(), effectiveEnabled: z.boolean(), module: EngramModuleReferenceSchema, modelHash: Hash,
}).strict();
export type ResolvedEngramSelection = z.infer<typeof ResolvedEngramSelectionSchema>;

export function parseAndVerifyResolvedEngramSelection(raw: unknown, options: EngramInferenceOptions) {
  const value = ResolvedEngramSelectionSchema.parse(raw), request = EngramInferenceOptionsSchema.parse(options);
  if (value.requested !== (request.engram === undefined ? "inherit" : request.engram ? "on" : "off")
    || value.effectiveEnabled !== (request.engram ?? value.defaultEnabled)
    || request.savedModel && canonicalJson(request.savedModel) !== canonicalJson(value.savedModel))
    throw new OpenPondProtocolError("engram_selection_mismatch", "The admitted memory module differs from this exact Model or request.");
  return value;
}

export const EngramInferenceReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramInferenceReceipt.v1"),
  teamId: Id, requestId: Id, requestHash: Hash, selection: ResolvedEngramSelectionSchema,
  poolId: Id, routingBinding: z.object({id: Id, revision: z.number().int().positive()}).strict(),
  runtimeHash: Hash, workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  engineGeneration: z.number().int().positive(), cacheNamespace: Hash, completedAt: z.iso.datetime(),
}).strict();
export const EngramInferenceReceiptSchema = EngramInferenceReceiptContentSchema.extend({contentHash: Hash});
export type EngramInferenceReceipt = z.infer<typeof EngramInferenceReceiptSchema>;
export async function parseAndVerifyEngramInferenceReceipt(raw: unknown, expected: {
  teamId: string; requestId: string; requestHash: string; options: EngramInferenceOptions;
  selection: ResolvedEngramSelection; poolId: string; routingBinding: {id: string; revision: number};
  runtimeHash: string; workerImageDigest: string; engineGeneration: number; cacheNamespace: string;
}) {
  const value = EngramInferenceReceiptSchema.parse(raw), {contentHash, ...content} = value;
  parseAndVerifyResolvedEngramSelection(value.selection, expected.options);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.requestId !== expected.requestId
    || value.requestHash !== expected.requestHash || canonicalJson(value.selection) !== canonicalJson(expected.selection)
    || value.poolId !== expected.poolId || canonicalJson(value.routingBinding) !== canonicalJson(expected.routingBinding)
    || value.runtimeHash !== expected.runtimeHash || value.workerImageDigest !== expected.workerImageDigest
    || value.engineGeneration !== expected.engineGeneration || value.cacheNamespace !== expected.cacheNamespace)
    throw new OpenPondProtocolError("engram_inference_receipt_mismatch", "The completed inference differs from its admitted memory module, runtime or cache.");
  return value;
}
