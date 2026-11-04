import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { SavedSteeringModelSelectionSchema, SteeringPublicationReferenceSchema,
  type SavedSteeringModelSelection } from "./steering-model-selection.js";
import { SteeringModelVersionSchema, parseAndVerifySavedModelVersion } from "./steering-profile-publication.js";
import { NeuronSteeringReferenceSchema } from "./neuron-steering.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().trim().min(1).max(500);

/** Absence inherits the admitted default; null explicitly disables steering.
 * Never normalize either case into the other before hashing a request. */
export const SteeringInferenceOptionsSchema = z.object({
  savedModel: SavedSteeringModelSelectionSchema.optional(),
  steering: SteeringPublicationReferenceSchema.nullable().optional(),
}).strict();
export type SteeringInferenceOptions = z.infer<typeof SteeringInferenceOptionsSchema>;

export async function savedSteeringModelSelection(raw: unknown): Promise<SavedSteeringModelSelection> {
  const version = SteeringModelVersionSchema.parse(raw);
  await parseAndVerifySavedModelVersion(version);
  return { modelProjectId: version.modelProjectId, versionHash: version.contentHash };
}

export const ResolvedSteeringSelectionSchema = z.object({
  schemaVersion: z.literal("openpond.resolvedSteeringSelection.v1"),
  requested: z.enum(["inherit", "off", "override"]),
  savedModel: SavedSteeringModelSelectionSchema.nullable(),
  defaultPublication: SteeringPublicationReferenceSchema.nullable(),
  effectivePublication: SteeringPublicationReferenceSchema.nullable(),
  profileHash: Hash.nullable(), modelHash: Hash,
  calibration: NeuronSteeringReferenceSchema.nullable(),
}).strict();
export type ResolvedSteeringSelection = z.infer<typeof ResolvedSteeringSelectionSchema>;

export async function parseAndVerifyResolvedSteeringSelection(raw: unknown, options: SteeringInferenceOptions) {
  const value = ResolvedSteeringSelectionSchema.parse(raw), request = SteeringInferenceOptionsSchema.parse(options);
  const mode = request.steering === undefined ? "inherit" : request.steering === null ? "off" : "override";
  const effective = mode === "inherit" ? value.defaultPublication : request.steering ?? null;
  if (value.requested !== mode || request.savedModel && canonicalJson(value.savedModel) !== canonicalJson(request.savedModel)
    || canonicalJson(value.effectivePublication) !== canonicalJson(effective)
    || (value.effectivePublication === null) !== (value.profileHash === null)
    || value.effectivePublication === null && value.calibration !== null)
    throw new OpenPondProtocolError("steering_selection_mismatch", "The admitted steering selection differs from the exact request and default.");
  return value;
}

/** A completed runner observation, separate from admission. Hosts must require
 * their authenticated worker proof before constructing this receipt. */
export const SteeringInferenceReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.steeringInferenceReceipt.v1"),
  teamId: Id, requestId: Id, requestHash: Hash, selection: ResolvedSteeringSelectionSchema,
  poolId: Id, routingBinding: z.object({ id: Id, revision: z.number().int().positive() }).strict().nullable(),
  runtimeHash: Hash, workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  engineGeneration: z.number().int().positive(), cacheNamespace: Hash,
  completedAt: z.iso.datetime(),
}).strict();
export const SteeringInferenceReceiptSchema = SteeringInferenceReceiptContentSchema.extend({ contentHash: Hash }).strict();
export type SteeringInferenceReceipt = z.infer<typeof SteeringInferenceReceiptSchema>;

export async function parseAndVerifySteeringInferenceReceipt(raw: unknown, expected: {
  teamId: string; requestId: string; requestHash: string; options: SteeringInferenceOptions;
  selection: ResolvedSteeringSelection; runtimeHash: string;
  poolId: string; routingBinding: { id: string; revision: number } | null;
  workerImageDigest: string; engineGeneration: number; cacheNamespace: string;
}) {
  const value = SteeringInferenceReceiptSchema.parse(raw), { contentHash, ...content } = value;
  await parseAndVerifyResolvedSteeringSelection(value.selection, expected.options);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.requestId !== expected.requestId
    || value.requestHash !== expected.requestHash || canonicalJson(value.selection) !== canonicalJson(expected.selection)
    || value.poolId !== expected.poolId || canonicalJson(value.routingBinding) !== canonicalJson(expected.routingBinding)
    || value.runtimeHash !== expected.runtimeHash || value.workerImageDigest !== expected.workerImageDigest
    || value.engineGeneration !== expected.engineGeneration || value.cacheNamespace !== expected.cacheNamespace)
    throw new OpenPondProtocolError("steering_inference_receipt_mismatch", "The completed inference differs from its admitted steering, runtime or cache identity.");
  return value;
}
