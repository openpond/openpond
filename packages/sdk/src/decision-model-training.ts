import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import {
  DECISION_ADAPTER_MAXIMUM_BYTES, DECISION_PROMPT_CODE_SHA256,
  DecisionModelIdentitySchema, parseAndVerifyDecisionModelIdentity, type DecisionModelIdentity,
} from "./decision-model.js";
import { DecisionArtifactReferenceSchema } from "./decision-model-data.js";
import {
  DecisionAdapterArtifactSchema, DecisionModuleFileSchema,
  parseAndVerifyDecisionAdapterArtifact,
} from "./decision-model-artifact.js";
import { canonicalJson, canonicalJsonByteLength, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DecisionTrainingSettingsSchema = z.object({
  learningRate: z.number().finite().positive().max(0.001),
  weightDecay: z.number().finite().min(0).max(0.1),
  maxSteps: z.number().int().min(1).max(4096),
  gradientAccumulationSteps: z.number().int().min(1).max(64),
  maximumPromptTokens: z.number().int().min(1).max(2048),
  seed: z.number().int().min(0).max(2_147_483_647),
  maxDurationSeconds: z.number().finite().min(1).max(21_600),
  maxCheckpointBytes: z.number().int().min(173_113_345).max(DECISION_ADAPTER_MAXIMUM_BYTES),
}).strict();
export type DecisionTrainingSettings = z.infer<typeof DecisionTrainingSettingsSchema>;
export const DecisionTrainingDataSchema = z.object({
  batch: ModelProjectVersionedRefSchema, examplesSha256: Hash, encodingHash: Hash,
}).strict();
export type DecisionTrainingData = z.infer<typeof DecisionTrainingDataSchema>;

export const DecisionSupervisedEncodingSchema = z.object({
  schemaVersion: z.literal("openpond.decisionSupervisedEncoding.v1"),
  implementation: z.literal("nimble_reference_candidate_logits_v1"),
  modelHash: Hash, tokenizerHash: Hash,
  promptCodeSha256: z.literal(DECISION_PROMPT_CODE_SHA256),
  maximumPromptTokens: z.number().int().min(1).max(2048),
  stateEncoding: z.literal("canonical_json_utf8_v1"), integerLevels: z.literal("decimal_enum_strings_v1"),
  labelsOutsidePrompt: z.literal(true), objective: z.literal("candidate_cross_entropy_v1"),
  temperature: z.literal(1), enableThinking: z.literal(false), truncation: z.literal(false),
  microBatchSize: z.literal(1),
}).strict();
export type DecisionSupervisedEncoding = z.infer<typeof DecisionSupervisedEncodingSchema>;

/** This declares a reproducible encoder/objective, not measured token rows or
 * a grant to train. The Dataset owner must resolve and authorize the reviewed
 * batch; the trainer must verify actual prompt/candidate boundary tokenization. */
export async function decisionSupervisedEncoding(model: DecisionModelIdentity, maximumPromptTokens: number) {
  const verified = await parseAndVerifyDecisionModelIdentity(model);
  return DecisionSupervisedEncodingSchema.parse({
    schemaVersion: "openpond.decisionSupervisedEncoding.v1", implementation: "nimble_reference_candidate_logits_v1",
    modelHash: await canonicalSha256(verified), tokenizerHash: verified.tokenizer.contentHash,
    promptCodeSha256: DECISION_PROMPT_CODE_SHA256, maximumPromptTokens,
    stateEncoding: "canonical_json_utf8_v1", integerLevels: "decimal_enum_strings_v1",
    labelsOutsidePrompt: true, objective: "candidate_cross_entropy_v1", temperature: 1,
    enableThinking: false, truncation: false, microBatchSize: 1,
  });
}

export const DecisionTrainingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.decisionTrainingRequest.v1"),
  model: DecisionModelIdentitySchema, data: DecisionTrainingDataSchema,
  training: DecisionTrainingSettingsSchema,
  // Null initializes the exact released Nimble adapter, never random LoRA or a bare base.
  parentArtifact: DecisionArtifactReferenceSchema.nullable(),
}).strict();
export type DecisionTrainingRequest = z.infer<typeof DecisionTrainingRequestSchema>;
export async function parseAndVerifyDecisionTrainingRequest(raw: unknown) {
  assertBoundedTaskJson(raw, 131_072);
  const value = DecisionTrainingRequestSchema.parse(raw);
  if (value.data.encodingHash !== await canonicalSha256(await decisionSupervisedEncoding(value.model, value.training.maximumPromptTokens)))
    throw new OpenPondProtocolError("decision_encoding_mismatch", "The decision request differs from its exact candidate-only supervised encoder.");
  return value;
}

export const DecisionTrainingResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionTrainingResult.v1"),
  inputHash: Hash, modelHash: Hash, runtimeHash: Hash, dataHash: Hash, preparedRowsHash: Hash,
  initialAdapterSourceHash: Hash,
  optimizerSteps: z.number().int().min(1).max(4096),
  examplesProcessed: z.number().int().min(1).max(262_144),
  questionRowsProcessed: z.number().int().min(1).max(262_144),
  targetTokens: z.number().int().min(1).max(262_144),
  forwardTokenWork: z.number().int().positive().max(536_870_912),
  durationMs: z.number().finite().nonnegative().max(21_600_000),
  meanLoss: z.number().finite().nonnegative(), finalLoss: z.number().finite().nonnegative(),
  trainableParameterCount: z.literal(43_278_336),
  baseOptimizerParameterCount: z.literal(0), baseGradientParameterCount: z.literal(0),
  frozenBackboneState: z.object({
    algorithm: z.literal("torch_state_dict_sha256_v1"), sourceManifestHash: Hash,
    before: Hash, after: Hash,
  }).strict(),
  artifact: z.object({
    id: z.string().min(1).max(500), contentHash: Hash,
    manifest: DecisionAdapterArtifactSchema, files: z.array(DecisionModuleFileSchema).length(4),
  }).strict(),
}).strict();
export const DecisionTrainingResultSchema = DecisionTrainingResultContentSchema.extend({ contentHash: Hash });
export type DecisionTrainingResult = z.infer<typeof DecisionTrainingResultSchema>;

/** Sealed metadata is necessary but not sufficient for a trained Model. Actual
 * custody/producer authentication and native frozen-state measurement remain
 * owner responsibilities. A measured torch-state hash is never compared to a
 * source-file manifest hash; the algorithm and source provenance stay distinct. */
export async function parseAndVerifyDecisionTrainingResult(raw: unknown, expected: {
  request: DecisionTrainingRequest; runtimeHash: string;
}) {
  assertBoundedTaskJson(raw, 524_288);
  const request = await parseAndVerifyDecisionTrainingRequest(expected.request);
  const value = DecisionTrainingResultSchema.parse(raw), { contentHash, ...content } = value;
  const manifest = await parseAndVerifyDecisionAdapterArtifact(value.artifact.manifest, {
    model: request.model, inputHash: await canonicalSha256(request),
    recipeHash: await canonicalSha256(request.training), dataHash: await canonicalSha256(request.data),
    runtimeHash: Hash.parse(expected.runtimeHash), parentArtifactHash: request.parentArtifact?.contentHash ?? null,
  });
  const fail = (): never => { throw new OpenPondProtocolError("decision_training_result_mismatch", "The decision result differs from its exact run, frozen backbone evidence or committed artifact."); };
  if (contentHash !== await canonicalSha256(content)
    || value.inputHash !== manifest.pins.inputHash || value.modelHash !== await canonicalSha256(request.model)
    || value.runtimeHash !== expected.runtimeHash || value.dataHash !== manifest.pins.dataHash
    || value.initialAdapterSourceHash !== (request.parentArtifact?.contentHash ?? request.model.originalAdapter.contentHash)
    || value.optimizerSteps !== request.training.maxSteps
    || value.questionRowsProcessed !== value.optimizerSteps * request.training.gradientAccumulationSteps
    || value.examplesProcessed > value.questionRowsProcessed || value.targetTokens !== value.questionRowsProcessed
    || value.forwardTokenWork < value.questionRowsProcessed
    || value.forwardTokenWork > value.questionRowsProcessed * request.training.maximumPromptTokens
    || value.durationMs > request.training.maxDurationSeconds * 1000
    || value.frozenBackboneState.sourceManifestHash !== request.model.backbone.source.contentHash
    || value.frozenBackboneState.before !== value.frozenBackboneState.after
    || value.artifact.contentHash !== manifest.contentHash
    || new Set(value.artifact.files.map(file => file.path)).size !== 4
    || value.artifact.files.some(file => file.artifactId !== value.artifact.id)
    || value.artifact.files.reduce((sum, file) => sum + file.sizeBytes, 0) > request.training.maxCheckpointBytes) fail();
  const tensor = value.artifact.files.find(file => file.path === "adapter_model.safetensors");
  if (!tensor || tensor.sha256 !== manifest.payload.sha256 || tensor.sizeBytes !== manifest.payload.sizeBytes) fail();
  for (const [path, payload] of [
    ["manifest.json", manifest], ["adapter_config.json", manifest.adapterConfig], ["decision_contract.json", manifest.contract],
  ] as const) {
    const file = value.artifact.files.find(row => row.path === path);
    // Metadata files are canonical JSON UTF-8 with no trailing newline.
    if (!file || file.sha256 !== await canonicalSha256(payload)
      || file.sizeBytes !== canonicalJsonByteLength(payload)
      || file.sizeBytes > 262_144) fail();
  }
  // Include all original parent/source and authored setting fields in the run hash.
  if (canonicalJson(request.model) !== canonicalJson(manifest.model)) fail();
  return value;
}
