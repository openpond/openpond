import { z } from "zod";
import {
  DECISION_ADAPTER_MAXIMUM_BYTES, DECISION_BACKBONE_REPOSITORY, DECISION_BACKBONE_REVISION,
  DECISION_PROMPT_CODE_SHA256, DecisionModelIdentitySchema, parseAndVerifyDecisionModelIdentity,
  type DecisionModelIdentity,
} from "./decision-model.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const targetModules = ["o_proj", "down_proj", "k_proj", "gate_proj", "in_proj_b", "in_proj_z", "in_proj_a", "out_proj", "q_proj", "in_proj_qkv", "v_proj", "up_proj"] as const;

/** Portable PEFT output configuration. Tensor names and shapes remain specific
 * to the full pinned Qwen3.5 hybrid backbone, not an ordinary dense LoRA model. */
export const DecisionAdapterConfigSchema = z.object({
  base_model_name_or_path: z.literal(DECISION_BACKBONE_REPOSITORY),
  revision: z.literal(DECISION_BACKBONE_REVISION),
  peft_type: z.literal("LORA"), peft_version: z.literal("0.21.0"), task_type: z.literal("CAUSAL_LM"),
  r: z.literal(16), lora_alpha: z.literal(32), lora_dropout: z.literal(0.05),
  bias: z.literal("none"), inference_mode: z.literal(true),
  fan_in_fan_out: z.literal(false), use_dora: z.literal(false), use_rslora: z.literal(false),
  modules_to_save: z.null(),
  target_modules: z.array(z.enum(targetModules)).length(12),
}).strict().superRefine((value, context) => {
  if (canonicalJson(value.target_modules) !== canonicalJson(targetModules))
    context.addIssue({ code: "custom", path: ["target_modules"], message: "The adapter must retain the exact released hybrid target modules." });
});
export type DecisionAdapterConfig = z.infer<typeof DecisionAdapterConfigSchema>;
export function decisionAdapterConfig(): DecisionAdapterConfig {
  return DecisionAdapterConfigSchema.parse({
    base_model_name_or_path: DECISION_BACKBONE_REPOSITORY, revision: DECISION_BACKBONE_REVISION,
    peft_type: "LORA", peft_version: "0.21.0", task_type: "CAUSAL_LM", r: 16,
    lora_alpha: 32, lora_dropout: 0.05, bias: "none", inference_mode: true,
    fan_in_fan_out: false, use_dora: false, use_rslora: false, modules_to_save: null,
    target_modules: [...targetModules],
  });
}

export const DecisionArtifactContractSchema = z.object({
  schemaVersion: z.literal("openpond.decisionArtifactContract.v1"),
  task: z.literal("schema_candidate_classification_v1"),
  modelHash: Hash, tokenizerHash: Hash, promptCodeSha256: z.literal(DECISION_PROMPT_CODE_SHA256),
  stateEncoding: z.literal("canonical_json_utf8_v1"),
  integerLevels: z.literal("decimal_enum_strings_v1"),
  objective: z.literal("candidate_cross_entropy_v1"), labelsOutsidePrompt: z.literal(true),
  temperature: z.literal(1), maximumPromptTokens: z.literal(2048),
  enableThinking: z.literal(false), truncation: z.literal(false),
}).strict();
export type DecisionArtifactContract = z.infer<typeof DecisionArtifactContractSchema>;
export async function decisionArtifactContract(model: DecisionModelIdentity): Promise<DecisionArtifactContract> {
  const verified = await parseAndVerifyDecisionModelIdentity(model);
  return DecisionArtifactContractSchema.parse({
    schemaVersion: "openpond.decisionArtifactContract.v1", task: "schema_candidate_classification_v1",
    modelHash: await canonicalSha256(verified), tokenizerHash: verified.tokenizer.contentHash,
    promptCodeSha256: DECISION_PROMPT_CODE_SHA256, stateEncoding: "canonical_json_utf8_v1",
    integerLevels: "decimal_enum_strings_v1", objective: "candidate_cross_entropy_v1",
    labelsOutsidePrompt: true, temperature: 1, maximumPromptTokens: 2048,
    enableThinking: false, truncation: false,
  });
}

export const DecisionAdapterTensorSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.]{1,200}$/),
  shape: z.tuple([z.number().int().positive().max(12_288), z.number().int().positive().max(12_288)]),
  dtype: z.literal("F32"),
}).strict();

/** Exact 496-tensor inventory observed in the original adapter's safetensors
 * header. Full-attention layers occur at indices 3,7,...31; other layers use
 * linear attention. Neither the language head nor vision weights are adapted. */
export function decisionAdapterTensorInventory(): z.infer<typeof DecisionAdapterTensorSchema>[] {
  const items: z.infer<typeof DecisionAdapterTensorSchema>[] = [];
  for (let layer = 0; layer < 32; layer++) {
    const modules: Array<[string, number, number]> = [
      ["mlp.down_proj", 12_288, 4096], ["mlp.gate_proj", 4096, 12_288], ["mlp.up_proj", 4096, 12_288],
      ...(layer % 4 === 3 ? [
        ["self_attn.q_proj", 4096, 8192], ["self_attn.k_proj", 4096, 1024],
        ["self_attn.v_proj", 4096, 1024], ["self_attn.o_proj", 4096, 4096],
      ] as Array<[string, number, number]> : [
        ["linear_attn.in_proj_a", 4096, 32], ["linear_attn.in_proj_b", 4096, 32],
        ["linear_attn.in_proj_qkv", 4096, 8192], ["linear_attn.in_proj_z", 4096, 4096],
        ["linear_attn.out_proj", 4096, 4096],
      ] as Array<[string, number, number]>),
    ];
    for (const [name, input, output] of modules) {
      const prefix = `base_model.model.model.language_model.layers.${layer}.${name}`;
      items.push({ name: `${prefix}.lora_A.weight`, shape: [16, input], dtype: "F32" });
      items.push({ name: `${prefix}.lora_B.weight`, shape: [output, 16], dtype: "F32" });
    }
  }
  return items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export const DecisionAdapterArtifactContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionAdapterArtifact.v1"), method: z.literal("decision_model"),
  model: DecisionModelIdentitySchema, adapterConfig: DecisionAdapterConfigSchema,
  contract: DecisionArtifactContractSchema,
  pins: z.object({
    inputHash: Hash, recipeHash: Hash, dataHash: Hash, runtimeHash: Hash, parentArtifactHash: Hash.nullable(),
  }).strict(),
  payload: z.object({
    path: z.literal("adapter_model.safetensors"), sha256: Hash,
    sizeBytes: z.number().int().positive().max(DECISION_ADAPTER_MAXIMUM_BYTES),
    tensors: z.array(DecisionAdapterTensorSchema).length(496),
  }).strict(),
}).strict();
export const DecisionAdapterArtifactSchema = DecisionAdapterArtifactContentSchema.extend({ contentHash: Hash });
export type DecisionAdapterArtifact = z.infer<typeof DecisionAdapterArtifactSchema>;
export type DecisionArtifactExpectation = {
  model: DecisionModelIdentity; inputHash: string; recipeHash: string; dataHash: string;
  runtimeHash: string; parentArtifactHash: string | null;
};

/** Verifies manifest metadata only. The existing authenticated artifact owner
 * must separately seal actual file bytes, sizes, digests and tensor inventory. */
export async function parseAndVerifyDecisionAdapterArtifact(raw: unknown, expected?: DecisionArtifactExpectation) {
  const value = DecisionAdapterArtifactSchema.parse(raw), { contentHash, ...content } = value;
  await parseAndVerifyDecisionModelIdentity(value.model);
  const fail = (): never => { throw new OpenPondProtocolError("decision_artifact_mismatch", "The decision artifact differs from its exact hybrid module, source, recipe or data."); };
  if (contentHash !== await canonicalSha256(content)
    || canonicalJson(value.contract) !== canonicalJson(await decisionArtifactContract(value.model))
    || canonicalJson(value.payload.tensors) !== canonicalJson(decisionAdapterTensorInventory())
    || value.payload.sizeBytes < value.payload.tensors.reduce((sum, row) => sum + row.shape[0] * row.shape[1] * 4, 0)) fail();
  if (expected && (canonicalJson(value.model) !== canonicalJson(expected.model)
    || value.pins.inputHash !== expected.inputHash || value.pins.recipeHash !== expected.recipeHash
    || value.pins.dataHash !== expected.dataHash || value.pins.runtimeHash !== expected.runtimeHash
    || value.pins.parentArtifactHash !== expected.parentArtifactHash)) fail();
  return value;
}

export const DecisionModuleFileSchema = z.object({
  path: z.enum(["manifest.json", "adapter_model.safetensors", "adapter_config.json", "decision_contract.json"]),
  artifactId: z.string().min(1).max(500), sha256: Hash,
  sizeBytes: z.number().int().positive().max(DECISION_ADAPTER_MAXIMUM_BYTES),
}).strict();
