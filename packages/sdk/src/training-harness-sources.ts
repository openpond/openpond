import { z } from "zod";
import { ImmutableReleaseRefSchema, validateHarnessSourcePackage, type HarnessSourcePackage, type ImmutableReleaseRef } from "@openpond/harness";
import { assertCanonicalPayloadSize, TRAINING_INPUT_ARTIFACT_MAX_BYTES } from "./protocol.js";

export const TrainingHarnessSourcePublicationSchema = z.object({
  schemaVersion: z.literal("openpond.trainingHarnessSourcePublication.v1"),
  harnessRelease: ImmutableReleaseRefSchema,
  sourcePackageHash: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(TRAINING_INPUT_ARTIFACT_MAX_BYTES),
}).strict();

/** Publication stores immutable source only; it never starts training. */
export function createTrainingHarnessSourceClient(request: (path: string, init?: RequestInit, responseLimit?: number) => Promise<unknown>) {
  const route = (reference: ImmutableReleaseRef) => {
    const ref = ImmutableReleaseRefSchema.parse(reference);
    return `/v1/training/harness-sources/${encodeURIComponent(ref.id)}/${ref.contentHash}`;
  };
  return {
    async publishHarnessSource(value: HarnessSourcePackage) {
      assertCanonicalPayloadSize(value, TRAINING_INPUT_ARTIFACT_MAX_BYTES, "Training Harness source");
      const source = validateHarnessSourcePackage(value);
      const portability = source.agentSnapshot.portability;
      if (!portability.portable || portability.blockers.length || portability.localOnlyAssetRefs.length || portability.hostPrivateAssetRefs.length || source.harnessRelease.files.some(file => file.visibility !== "policy")) {
        throw new Error("Hosted training Harness publication requires portable, policy-visible source.");
      }
      const result = TrainingHarnessSourcePublicationSchema.parse(await request(route({ id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash }), { method: "PUT", body: JSON.stringify(source) }));
      if (result.harnessRelease.id !== source.harnessRelease.id || result.harnessRelease.contentHash !== source.harnessRelease.contentHash || result.sourcePackageHash !== source.contentHash) {
        throw new Error("Published Harness source differs from the selected immutable package.");
      }
      return result;
    },
    async getHarnessSource(reference: ImmutableReleaseRef) {
      const value = await request(route(reference), undefined, TRAINING_INPUT_ARTIFACT_MAX_BYTES);
      assertCanonicalPayloadSize(value, TRAINING_INPUT_ARTIFACT_MAX_BYTES, "Training Harness source");
      return validateHarnessSourcePackage(value, reference);
    },
  };
}
