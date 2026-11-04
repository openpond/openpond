import { z } from "zod";
import { ModelProjectImmutableRefSchema } from "./model-projects.js";
import { ModelModificationMethodSchema } from "./model-modification-capabilities.js";
import { TrainingResultCandidateSchema } from "./training-result.js";

const Id = z.string().trim().min(1).max(500);
const OwnerId = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ApiOrigin = z.url().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) &&
      !url.username && !url.password && !url.search && !url.hash && url.origin === value;
  } catch {
    return false;
  }
}, "Use a canonical HTTPS API origin, or an explicit loopback development origin.");

const scope = {
  location: z.literal("cloud"),
  apiOrigin: ApiOrigin,
  owner: z.object({ teamId: OwnerId, actorId: OwnerId }).strict(),
  /** Workspace Project captured by the producing execution, not a UI filter. */
  projectId: OwnerId.nullable(),
};

/** A retained completed candidate. Saving a named Model or publishing a registry
 * artifact is independent of this identity and must not change its reference. */
export const StoredTrainingResultReferenceSchema = z.object({
  ...scope,
  kind: z.literal("training_result"),
  jobId: Id,
  modelProjectId: Id,
  portableProjectId: Id,
  submissionHash: Hash,
  candidate: z.lazy(() => TrainingResultCandidateSchema.omit({ registryArtifactId: true })),
  executionReceipt: ModelProjectImmutableRefSchema,
}).strict().superRefine((reference, context) => {
  if ((reference.candidate.composition === "base") !== (reference.candidate.parent === null))
    context.addIssue({ code: "custom", path: ["candidate", "parent"], message: "The candidate composition must retain its exact parent checkpoint." });
});

/** Pins the recorded nested result, whose hash remains stable while cleanup,
 * settlement and the execution's outer read projection continue to change. */
export const StoredManagedModificationResultReferenceSchema = z.object({
  ...scope,
  kind: z.literal("managed_modification_result"),
  executionId: OwnerId,
  method: ModelModificationMethodSchema,
  inputHash: Hash,
  runtimeHash: Hash,
  resultHash: Hash,
}).strict();

/** A completed Engram result retains its committed module independently of the
 * mutable execution projection and any later named Model publication. */
export const StoredEngramResultReferenceSchema = z.object({
  ...scope,
  kind: z.literal("engram_result"),
  executionId: OwnerId,
  inputHash: Hash,
  runtimeHash: Hash,
  resultHash: Hash,
  artifact: z.object({ id: OwnerId, contentHash: Hash }).strict(),
}).strict();

/** Both modes retain the original execution result. Scoring the released
 * Nimble adapter has no customer artifact; trained results always retain their
 * committed learned artifact. Neither reference becomes a saved Model alias. */
export const StoredDecisionResultReferenceSchema = z.object({
  ...scope,
  kind: z.literal("decision_result"), mode: z.enum(["train", "score"]),
  executionId: OwnerId, inputHash: Hash, modelHash: Hash, runtimeHash: Hash, resultHash: Hash,
  artifact: z.object({ id: Id, contentHash: Hash }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.mode === "train" && value.artifact === null)
    context.addIssue({code: "custom", path: ["artifact"], message: "A trained decision result must retain its exact committed artifact."});
});

const learnedWeightResult = {
  ...scope, executionId: OwnerId, inputHash: Hash, modelHash: Hash, runtimeHash: Hash, resultHash: Hash,
  artifact: z.object({id: Id, contentHash: Hash}).strict(),
};
export const StoredAlphaEditResultReferenceSchema = z.object({
  ...learnedWeightResult, kind: z.literal("alphaedit_result"),
}).strict();
export const StoredNeuronTrainingResultReferenceSchema = z.object({
  ...learnedWeightResult, kind: z.literal("neuron_training_result"),
}).strict();

/** References contain no result bytes, credentials or execution approval. Each
 * read must use the authenticated configured origin, reauthorize creator/team/
 * Project access and verify every pin against its canonical result owner. */
export const StoredExperimentResultReferenceSchema = z.discriminatedUnion("kind", [
  StoredTrainingResultReferenceSchema,
  StoredManagedModificationResultReferenceSchema,
  StoredEngramResultReferenceSchema,
  StoredDecisionResultReferenceSchema,
  StoredAlphaEditResultReferenceSchema,
  StoredNeuronTrainingResultReferenceSchema,
]);
export type StoredTrainingResultReference = z.infer<typeof StoredTrainingResultReferenceSchema>;
export type StoredManagedModificationResultReference = z.infer<typeof StoredManagedModificationResultReferenceSchema>;
export type StoredEngramResultReference = z.infer<typeof StoredEngramResultReferenceSchema>;
export type StoredDecisionResultReference = z.infer<typeof StoredDecisionResultReferenceSchema>;
export type StoredAlphaEditResultReference = z.infer<typeof StoredAlphaEditResultReferenceSchema>;
export type StoredNeuronTrainingResultReference = z.infer<typeof StoredNeuronTrainingResultReferenceSchema>;
export type StoredExperimentResultReference = z.infer<typeof StoredExperimentResultReferenceSchema>;
