import { z } from "zod";
import { ActivationReferencePromptSchema } from "./activation-reference.js";
import { NeuronSteeringModelSchema, NeuronResidualCalibrationSchema,
  parseAndVerifyNeuronResidualCalibration } from "./neuron-steering.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** One unsteered forward over an explicit tokenized source. No result scales
 * or profile publication evidence are accepted as a calibration source. */
export const NeuronResidualCalibrationRequestSchema = z.object({
  schemaVersion: z.literal("openpond.neuronResidualCalibrationRequest.v1"),
  id: Id, revision: z.number().int().positive(), model: NeuronSteeringModelSchema,
  prompt: ActivationReferencePromptSchema,
  layers: z.array(z.number().int().nonnegative().max(511)).min(1).max(512),
  maximumForwardTokenWork: z.number().int().positive().max(1_000_000),
  maximumDurationSeconds: z.number().finite().positive().max(300),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.layers).size !== value.layers.length || value.layers.some(layer => layer >= value.model.intermediateSizes.length))
    ctx.addIssue({ code: "custom", path: ["layers"], message: "Use unique layers inside the exact model." });
  if (value.prompt.attentionMask.filter(Boolean).length < 2)
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "Calibration requires a visible token after position zero." });
  if (value.prompt.tokenIds.length > value.maximumForwardTokenWork)
    ctx.addIssue({ code: "custom", path: ["maximumForwardTokenWork"], message: "The complete unsteered forward exceeds its declared budget." });
});
export type NeuronResidualCalibrationRequest = z.infer<typeof NeuronResidualCalibrationRequestSchema>;

export const NeuronResidualCalibrationExportContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronResidualCalibrationExport.v1"),
  model: NeuronSteeringModelSchema, prompt: ActivationReferencePromptSchema,
  calibration: NeuronResidualCalibrationSchema,
  runtime: z.object({ implementation: z.literal("torch_dense_serial_calibration_v1"), implementationHash: Hash,
    torchVersion: Id, device: Id }).strict(),
}).strict();
export const NeuronResidualCalibrationExportSchema = NeuronResidualCalibrationExportContentSchema.extend({ contentHash: Hash }).strict();
export type NeuronResidualCalibrationExport = z.infer<typeof NeuronResidualCalibrationExportSchema>;

export async function parseAndVerifyNeuronResidualCalibrationExport(raw: unknown, expected?: NeuronResidualCalibrationRequest) {
  const value = NeuronResidualCalibrationExportSchema.parse(raw), { contentHash, ...content } = value;
  const calibration = await parseAndVerifyNeuronResidualCalibration(value.calibration, value.model);
  const sourceHash = await canonicalSha256(value.prompt), samples = value.prompt.attentionMask.filter(Boolean).length - 1;
  let mismatch = contentHash !== await canonicalSha256(content) || samples <= 0
    || calibration.source.id !== value.prompt.id || calibration.source.contentHash !== sourceHash
    || calibration.layers.some(layer => layer.sampleCount !== samples);
  if (expected) {
    const request = NeuronResidualCalibrationRequestSchema.parse(expected);
    mismatch ||= canonicalJson(value.model) !== canonicalJson(request.model) || canonicalJson(value.prompt) !== canonicalJson(request.prompt)
      || calibration.id !== request.id || calibration.revision !== request.revision
      || canonicalJson(calibration.layers.map(row => row.layer).sort((a, b) => a - b)) !== canonicalJson([...request.layers].sort((a, b) => a - b));
  }
  if (mismatch) throw new OpenPondProtocolError("neuron_calibration_export_mismatch", "The original residual calibration differs from its exact measured model, tokenized source or layers.");
  return value;
}
