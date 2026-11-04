import { z } from "zod";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** An immutable publication identity, never a mutable profile record revision. */
export const SteeringPublicationReferenceSchema = z.object({
  id: Id, revision: z.number().int().positive(), contentHash: Hash,
}).strict();
export type SteeringPublicationReference = z.infer<typeof SteeringPublicationReferenceSchema>;

/** Pins a saved Model without copying its publication or result evidence. */
export const SavedSteeringModelSelectionSchema = z.object({
  modelProjectId: Id, versionHash: Hash,
}).strict();
export type SavedSteeringModelSelection = z.infer<typeof SavedSteeringModelSelectionSchema>;
