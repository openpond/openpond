import { ActivationStartingProfileSchema } from "./steering-experiment-source.js";
import { z } from "zod";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { NeuronSteeringModelSchema, NeuronSteeringProfileSchema, parseAndVerifyNeuronSteeringProfile } from "./neuron-steering.js";

const Id = z.string().trim().min(1).max(500), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ActivationReferencePromptSchema = z.object({ id: Id,
  tokenIds: z.array(z.number().int().nonnegative().max(2_147_483_647)).min(1).max(4096),
  attentionMask: z.array(z.union([z.literal(0), z.literal(1)])).min(1).max(4096),
}).strict().superRefine((value, ctx) => {
  if (value.tokenIds.length !== value.attentionMask.length || !value.attentionMask.some(Boolean) || value.attentionMask.at(-1) !== 1)
    ctx.addIssue({ code: "custom", message: "Use matching tokens and a nonempty left-padded prompt." });
  let foundToken = false;
  for (const mask of value.attentionMask) {
    if (mask) foundToken = true;
    else if (foundToken) ctx.addIssue({ code: "custom", path: ["attentionMask"], message: "The reference admits only contiguous left padding." });
  }
});
export const ActivationReferenceRequestSchema = z.object({
  schemaVersion: z.literal("openpond.activationReferenceRequest.v1"), model: NeuronSteeringModelSchema,
  startingProfile: ActivationStartingProfileSchema.optional(),
  prompts: z.array(ActivationReferencePromptSchema).min(1).max(8),
  variants: z.array(z.object({ id: Id, profile: z.lazy(() => NeuronSteeringProfileSchema).nullable() }).strict()).min(1).max(17),
  capture: z.array(z.object({ layer: z.number().int().nonnegative().max(511),
    neurons: z.array(z.number().int().nonnegative().max(9_999_999)).min(1).max(64) }).strict()).min(1).max(64),
  maxNewTokens: z.number().int().nonnegative().max(128), eosTokenIds: z.array(z.number().int().nonnegative().max(2_147_483_647)).max(16),
  maximumCapturedValues: z.number().int().positive().max(65_536),
  maximumForwardTokenWork: z.number().int().positive().max(1_000_000), maximumDurationSeconds: z.number().finite().positive().max(300),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.prompts.map(item => item.id)).size !== value.prompts.length || new Set(value.variants.map(item => item.id)).size !== value.variants.length)
    ctx.addIssue({ code: "custom", message: "Prompt and variant IDs must be unique." });
  if (value.startingProfile) {
    const reference = value.variants.find(row => row.id === value.startingProfile!.variantId);
    if (!reference?.profile || reference.profile.contentHash !== value.startingProfile.profileHash || !value.variants.some(row => row.profile === null))
      ctx.addIssue({code: "custom", path: ["startingProfile"], message: "Retain the exact saved profile variant and a separate Off control."});
  }
  const seen = new Set<string>();
  for (const row of value.capture) for (const neuron of row.neurons) {
    const key = `${row.layer}:${neuron}`;
    if (seen.has(key) || neuron >= (value.model.intermediateSizes[row.layer] ?? 0)) ctx.addIssue({ code: "custom", path: ["capture"], message: "Capture coordinates must be unique and inside the model." });
    seen.add(key);
  }
});
export type ActivationReferenceRequest = z.infer<typeof ActivationReferenceRequestSchema>;
export async function parseAndVerifyActivationReferenceRequest(raw: unknown) {
  const value = ActivationReferenceRequestSchema.parse(raw);
  for (const variant of value.variants) if (variant.profile) await parseAndVerifyNeuronSteeringProfile(variant.profile, value.model);
  const coordinates = value.capture.reduce((sum, row) => sum + row.neurons.length, 0), n = value.maxNewTokens;
  const captures = value.prompts.reduce((sum, row) => sum + row.attentionMask.filter(Boolean).length + n, 0) * value.variants.length * coordinates * 2;
  const work = value.prompts.reduce((sum, prompt) => sum + value.variants.reduce((subtotal, variant) => subtotal
    + (n + 1) * prompt.tokenIds.length + n * (n + 1) / 2
    + (variant.profile?.normalization.mode === "baseline_prompt_residual_median" ? prompt.tokenIds.length : 0), 0), 0);
  if (captures > value.maximumCapturedValues || work > value.maximumForwardTokenWork)
    throw new OpenPondProtocolError("activation_reference_budget_exceeded", "The full requested capture and forward work exceed their declared bounds.");
  return value;
}

export const ActivationReferenceCaptureSchema = z.object({ promptId: Id, variantId: Id,
  layer: z.number().int().nonnegative(), neuron: z.number().int().nonnegative(), tokenIndex: z.number().int().nonnegative(),
  tokenId: z.number().int().nonnegative(), before: z.number().finite(), after: z.number().finite(),
}).strict();
export const ActivationReferenceOutcomeSchema = z.object({ promptId: Id, variantId: Id, profileHash: Hash.nullable(),
  generatedTokenIds: z.array(z.number().int().nonnegative()).max(128), forwardTokenWork: z.number().int().positive(),
  calibration: z.array(z.object({ layer: z.number().int().nonnegative(), median: z.number().finite().positive(), sampleCount: z.number().int().positive(),
    columnNorms: z.array(z.object({ neuron: z.number().int().nonnegative(), norm: z.number().finite().positive() }).strict()).max(64),
  }).strict()).max(64), durationMs: z.number().finite().nonnegative(), captureCount: z.number().int().nonnegative(),
}).strict();
export const ActivationReferenceResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.activationReferenceResult.v1"), requestHash: Hash, modelHash: Hash,
  runtime: z.object({ implementation: z.literal("torch_dense_serial_reference_v1"), implementationHash: Hash, torchVersion: Id, device: Id }).strict(),
  outcomes: z.array(ActivationReferenceOutcomeSchema).min(1).max(136), captures: z.array(ActivationReferenceCaptureSchema).max(32_768),
}).strict();
export const ActivationReferenceResultSchema = ActivationReferenceResultContentSchema.extend({ contentHash: Hash }).strict();
export type ActivationReferenceResult = z.infer<typeof ActivationReferenceResultSchema>;
export async function parseAndVerifyActivationReferenceResult(raw: unknown, input: ActivationReferenceRequest) {
  const request = await parseAndVerifyActivationReferenceRequest(input), value = ActivationReferenceResultSchema.parse(raw), { contentHash, ...content } = value;
  const fail = () => { throw new OpenPondProtocolError("activation_reference_result_mismatch", "The inspection differs from its exact prompt, model, intervention or capture bounds."); };
  if (contentHash !== await canonicalSha256(content) || value.requestHash !== await canonicalSha256(request)
    || value.modelHash !== await canonicalSha256(request.model) || value.captures.length * 2 > request.maximumCapturedValues
    || value.outcomes.length !== request.prompts.length * request.variants.length
    || value.outcomes.reduce((sum, row) => sum + row.forwardTokenWork, 0) > request.maximumForwardTokenWork) fail();
  const pairs = new Set<string>(), counts = new Map<string, number>(), captureKeys = new Set<string>();
  const prompts = new Map(request.prompts.map(row => [row.id, row])), variants = new Map(request.variants.map(row => [row.id, row]));
  for (const capture of value.captures) {
    const key = JSON.stringify([capture.promptId, capture.variantId]), token = JSON.stringify([key, capture.layer, capture.neuron, capture.tokenIndex]);
    if (captureKeys.has(token) || !prompts.has(capture.promptId) || !variants.has(capture.variantId)
      || !request.capture.some(row => row.layer === capture.layer && row.neurons.includes(capture.neuron))) fail();
    captureKeys.add(token); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of value.outcomes) {
    const key = JSON.stringify([row.promptId, row.variantId]), prompt = prompts.get(row.promptId), variant = variants.get(row.variantId);
    if (!prompt || !variant || pairs.has(key) || row.profileHash !== (variant?.profile?.contentHash ?? null)
      || row.generatedTokenIds.length > request.maxNewTokens || row.captureCount !== (counts.get(key) ?? 0)) fail();
    pairs.add(key);
    const tokenIds = prompt!.tokenIds.filter((_, index) => prompt!.attentionMask[index] === 1).concat(row.generatedTokenIds);
    const n = row.generatedTokenIds.length, coordinates = request.capture.reduce((sum, item) => sum + item.neurons.length, 0);
    const work = (n + 1) * prompt!.tokenIds.length + n * (n + 1) / 2
      + (variant!.profile?.normalization.mode === "baseline_prompt_residual_median" ? prompt!.tokenIds.length : 0);
    if (row.captureCount !== tokenIds.length * coordinates || row.forwardTokenWork !== work
      || variant!.profile === null && row.calibration.length !== 0) fail();
    if (n < request.maxNewTokens && (!n || !request.eosTokenIds.includes(row.generatedTokenIds[n - 1]!))
      || row.generatedTokenIds.slice(0, -1).some(token => request.eosTokenIds.includes(token))) fail();
    if (variant!.profile) {
      const targets = new Map<number, Set<number>>();
      for (const entry of variant!.profile.entries) { const neurons = targets.get(entry.layer) ?? new Set<number>(); neurons.add(entry.neuron); targets.set(entry.layer, neurons); }
      if (row.calibration.length !== targets.size || new Set(row.calibration.map(item => item.layer)).size !== targets.size
        || row.calibration.some(item => !targets.has(item.layer) || item.columnNorms.length !== targets.get(item.layer)!.size
          || new Set(item.columnNorms.map(column => column.neuron)).size !== item.columnNorms.length
          || item.columnNorms.some(column => !targets.get(item.layer)!.has(column.neuron))
          || variant!.profile!.normalization.mode === "baseline_prompt_residual_median" && item.sampleCount !== tokenIds.length - n - 1)) fail();
    }
    if (value.captures.some(capture => capture.promptId === row.promptId && capture.variantId === row.variantId && tokenIds[capture.tokenIndex] !== capture.tokenId)) fail();
  }
  return value;
}
