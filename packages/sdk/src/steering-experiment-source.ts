import { z } from "zod";
import { SavedSteeringModelSelectionSchema, SteeringPublicationReferenceSchema } from "./steering-model-selection.js";

/** Compact untrusted authoring provenance. Resolve and verify the full saved
 * version before using its profile; these pins alone grant no authority. */
export const SavedSteeringExperimentSourceSchema = SavedSteeringModelSelectionSchema.extend({
  publication: SteeringPublicationReferenceSchema,
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SavedSteeringExperimentSource = z.infer<typeof SavedSteeringExperimentSourceSchema>;
export const ActivationStartingProfileSchema = SavedSteeringExperimentSourceSchema.extend({
  variantId: z.string().trim().min(1).max(500),
}).strict();

/** The full source stays with authoring/resolution; request hashes bind its
 * compact provenance even when a prepare command omits the authoring form. */
export function activationStartingProfileSource(value: z.infer<typeof ActivationStartingProfileSchema>): SavedSteeringExperimentSource {
  const {variantId: _variant, ...source} = ActivationStartingProfileSchema.parse(value);
  return source;
}
