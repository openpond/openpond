import { verifySavedSteeringExperimentSource } from "./steering-experiment-source-verification.js";
import type { SteeringModelVersion } from "./steering-profile-publication.js";
import { ActivationExperimentFormDraftSchema, type ActivationExperimentFormDraft } from "./activation-experiment-draft.js";
import { parseAndVerifyActivationReferenceRequest, type ActivationReferenceRequest } from "./activation-reference.js";
import { ModelProjectBaseModelSchema } from "./model-projects.js";
import { createNeuronSteeringProfile, NeuronSteeringModelSchema, parseAndVerifyNeuronResidualCalibration,
  type NeuronSteeringModel, type NeuronResidualCalibration } from "./neuron-steering.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError, type CanonicalJsonValue } from "./protocol.js";

/** Trusted host adapter, never an HTTP input. Encoding preserves the original
 * literal text without padding or truncation. Its complete descriptor identifies
 * tokenizer files and encoding settings and must hash to model.tokenizerHash. */
export interface ActivationFormTokenizer {
  source: NonNullable<ActivationExperimentFormDraft["baseModel"]>;
  descriptor: Record<string, CanonicalJsonValue>;
  encode(text: string): readonly number[] | Promise<readonly number[]>;
}
const numberPattern = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
function fail(code: string): never { throw new OpenPondProtocolError(`activation_form_${code}`, "The activation form cannot be compiled with these exact inputs."); }
function decimal(text: string) {
  const value = text.trim();
  if (!numberPattern.test(value)) fail("number_incomplete");
  return value;
}
function finite(text: string) {
  const value = decimal(text), number = Number(value);
  if (!Number.isFinite(number) || number === 0 && /[1-9]/.test(value.split(/[eE]/)[0]!)) fail("number_out_of_range");
  return number;
}
/** Check integrality before converting to binary64; rounded fractions must not
 * become accepted coordinates. Exponents never allocate unbounded integers. */
function integer(text: string, low: number, high: number) {
  const value = decimal(text), negative = value.startsWith("-"), unsigned = value.replace(/^[+-]/, "");
  const [mantissa, exponent = "0"] = unsigned.split(/[eE]/), [whole, fraction = ""] = mantissa!.split(".");
  let digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) return low <= 0 && high >= 0 ? 0 : fail("integer_out_of_range");
  const scale = BigInt(exponent) - BigInt(fraction.length);
  if (scale < 0n) {
    const remove = -scale;
    if (remove >= BigInt(digits.length) || remove > BigInt(digits.length - digits.replace(/0+$/, "").length)) fail("integer_out_of_range");
    digits = digits.slice(0, digits.length - Number(remove));
  } else {
    if (BigInt(digits.length) + scale > BigInt(String(Math.max(Math.abs(low), Math.abs(high))).length)) fail("integer_out_of_range");
    digits += "0".repeat(Number(scale));
  }
  const result = Number(`${negative ? "-" : ""}${digits}`);
  if (!Number.isSafeInteger(result) || result < low || result > high) fail("integer_out_of_range");
  return result;
}
function multipliers(text: string) {
  // Python str.split also recognizes the C0 information separators.
  // eslint-disable-next-line no-control-regex
  const raw = text.trim(), parts = raw.includes(",") ? raw.split(",") : raw ? raw.split(/[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/) : [];
  if (parts.length < 1 || parts.length > 16) fail("sweep_size_invalid");
  const values = parts.map(finite);
  if (new Set(values).size !== values.length) fail("duplicate_multiplier");
  return values;
}

/** Pure bounded authoring compilation, matching the Python SDK compiler. This
 * grants no execution admission; the host must authorize assets and the executor
 * must independently verify its actual loaded model and calibration custody. */
export async function compileActivationForm(form: ActivationExperimentFormDraft, options: {
  method: "neuron_steering" | "inspect_activations"; model: NeuronSteeringModel; tokenizer: ActivationFormTokenizer;
  calibrations?: readonly NeuronResidualCalibration[]; maximumAbsoluteDose?: number;
  startingProfileVersion?: SteeringModelVersion;
}): Promise<ActivationReferenceRequest> {
  const raw = ActivationExperimentFormDraftSchema.parse(form), model = NeuronSteeringModelSchema.parse(options.model);
  const { method, tokenizer, calibrations = [], maximumAbsoluteDose = 16 } = options;
  if (method !== "neuron_steering" && method !== "inspect_activations") fail("method_unsupported");
  if (!raw.prompts.length || !raw.coordinates.length) fail("rows_invalid");
  if (typeof maximumAbsoluteDose !== "number" || !Number.isFinite(maximumAbsoluteDose) || maximumAbsoluteDose <= 0) fail("dose_limit_invalid");
  const source = ModelProjectBaseModelSchema.parse(tokenizer.source), descriptor = tokenizer.descriptor;
  if (!raw.baseModel || canonicalJson(raw.baseModel) !== canonicalJson(source) || !source.revision || !source.tokenizerRevision ||
      source.modelId !== model.modelId || source.revision !== model.revision || await canonicalSha256(descriptor) !== model.tokenizerHash)
    fail("tokenizer_identity_mismatch");
  const vocabulary = descriptor.vocabSize, eos = descriptor.eosTokenIds;
  if (typeof vocabulary !== "number" || !Number.isInteger(vocabulary) || vocabulary < 1 || vocabulary > 2_147_483_648 ||
      !Array.isArray(eos) || eos.length > 16 || eos.some(token => typeof token !== "number" || !Number.isInteger(token) || token < 0 || token >= vocabulary) ||
      new Set(eos).size !== eos.length || typeof tokenizer.encode !== "function") fail("tokenizer_descriptor_invalid");
  let startingProfile: SteeringModelVersion["publication"]["profile"] | null = null;
  if (raw.startingProfile) {
    if (method !== "neuron_steering") fail("saved_source_method_unsupported");
    if (!options.startingProfileVersion) fail("saved_source_unresolved");
    const version = await verifySavedSteeringExperimentSource(raw.startingProfile, options.startingProfileVersion);
    if (canonicalJson(version.publication.baseModel) !== canonicalJson(raw.baseModel) || canonicalJson(version.publication.profile.model) !== canonicalJson(model)) fail("saved_source_model_mismatch");
    startingProfile = version.publication.profile;
    if (startingProfile.entries.some(entry => Math.abs(entry.dose) > maximumAbsoluteDose)) fail("dose_limit_exceeded");
    if (startingProfile.normalization.mode === "fixed_residual_reference") {
      const reference = startingProfile.normalization.calibration;
      const matches = calibrations.filter(item => item.id === reference.id && item.revision === reference.revision && item.contentHash === reference.contentHash);
      if (matches.length !== 1) fail("calibration_unavailable");
      const calibration = await parseAndVerifyNeuronResidualCalibration(matches[0], model, reference);
      if (startingProfile.entries.some(entry => !calibration.layers.some(row => row.layer === entry.layer))) fail("calibration_incomplete");
    }
  } else if (options.startingProfileVersion) fail("saved_source_unrequested");
  const entries: { layer: number; neuron: number; dose: number }[] = [], capture = new Map<number, number[]>(), seen = new Set<string>();
  for (const row of raw.coordinates) {
    const layer = integer(row.layer, 0, model.intermediateSizes.length - 1), neuron = integer(row.neuron, 0, model.intermediateSizes[layer]! - 1);
    const key = `${layer}:${neuron}`;
    if (seen.has(key)) fail("duplicate_coordinate");
    seen.add(key); const neurons = capture.get(layer) ?? []; neurons.push(neuron); capture.set(layer, neurons);
    if (method === "neuron_steering") entries.push({ layer, neuron, dose: finite(row.dose) });
  }
  const variants: ActivationReferenceRequest["variants"] = [{ id: "baseline", profile: null }];
  if (startingProfile) variants.push({id: "saved-profile", profile: startingProfile});
  if (method === "neuron_steering") {
    if (raw.normalization.mode === "fixed_residual_reference") {
      const reference = raw.normalization.calibration;
      if (calibrations.some(item => !item || typeof item !== "object" || Array.isArray(item))) fail("calibration_invalid");
      const matches = calibrations.filter(item => item.id === reference.id && item.revision === reference.revision && item.contentHash === reference.contentHash);
      if (matches.length !== 1) fail("calibration_unavailable");
      const calibration = await parseAndVerifyNeuronResidualCalibration(matches[0], model, reference);
      if (entries.some(entry => !calibration.layers.some(row => row.layer === entry.layer))) fail("calibration_incomplete");
    }
    for (const [index, multiplier] of multipliers(raw.doseMultipliers).entries()) {
      const scaled = entries.map(entry => ({ ...entry, dose: entry.dose * multiplier }));
      if (scaled.some((entry, i) => !Number.isFinite(entry.dose) || Math.abs(entry.dose) > maximumAbsoluteDose ||
          entry.dose === 0 && entries[i]!.dose !== 0 && multiplier !== 0)) fail("dose_limit_exceeded");
      const profile = await createNeuronSteeringProfile({
        schemaVersion: "openpond.neuronSteeringProfile.v1", model, hook: "mlp.down_proj.input", operation: "add",
        normalization: raw.normalization, tokenScope: raw.tokenScope, entries: scaled,
      });
      if (!startingProfile || !variants.some(variant => variant.profile?.contentHash === profile.contentHash))
        variants.push({id: `strength-${index + 1}`, profile});
    }
  }
  if (variants.length > 17) fail("variant_limit_exceeded");
  // Reject incomplete numeric budgets before invoking a potentially costly host encoder.
  const bounds = {maxNewTokens: integer(raw.maxNewTokens, 0, 128), maximumCapturedValues: integer(raw.maximumCapturedValues, 1, 65_536),
    maximumForwardTokenWork: integer(raw.maximumForwardTokenWork, 1, 1_000_000), maximumDurationSeconds: finite(raw.maximumDurationSeconds)};
  if (bounds.maximumDurationSeconds <= 0 || bounds.maximumDurationSeconds > 300) fail("number_out_of_range");
  const prompts: ActivationReferenceRequest["prompts"] = [];
  for (const prompt of raw.prompts) {
    if (!prompt.text) fail("prompt_empty");
    let encoded: readonly number[];
    try { encoded = await tokenizer.encode(prompt.text); } catch { fail("tokenization_failed"); }
    if (!Array.isArray(encoded) || encoded.length < 1 || encoded.length > 4096 ||
        encoded.some(token => typeof token !== "number" || !Number.isInteger(token) || token < 0 || token >= vocabulary)) fail("tokenization_invalid");
    prompts.push({ id: prompt.id, tokenIds: [...encoded], attentionMask: encoded.map(() => 1) });
  }
  if (variants.some(row => row.profile?.normalization.mode === "baseline_prompt_residual_median") && prompts.some(prompt => prompt.tokenIds.length < 2))
    fail("calibration_prompt_too_short");
  return parseAndVerifyActivationReferenceRequest({ schemaVersion: "openpond.activationReferenceRequest.v1", model, prompts, variants,
    ...(raw.startingProfile ? {startingProfile: {...raw.startingProfile, variantId: "saved-profile"}} : {}),
    capture: Array.from(capture, ([layer, neurons]) => ({ layer, neurons })), eosTokenIds: eos,
    ...bounds });
}
