import { z } from "zod";
import { ModelProjectBaseModelSchema } from "./model-projects.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

export const DECISION_SOURCE_REPOSITORY = "bespokelabs/Bespoke-Nimble-9B";
export const DECISION_SOURCE_REVISION = "e93fabce8fcee46e7e8b45e2d955b8a4f0035917";
export const DECISION_BACKBONE_REPOSITORY = "Qwen/Qwen3.5-9B";
export const DECISION_BACKBONE_REVISION = "c202236235762e1c871ad0ccb60c8ee5ba337b9a";
export const DECISION_PROMPT_CODE_SHA256 = "a0a0f94d0f65e972bc20d088678ad3d595ff1c42b9c0d78f96034526303f63fc";
export const DECISION_CHAT_TEMPLATE_SHA256 = "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715";
export const DECISION_ADAPTER_MAXIMUM_BYTES = 268_435_456;

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DecisionSourceFileSchema = z.object({
  path: z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/), sha256: Hash,
  sizeBytes: z.number().int().positive().max(25_000_000_000),
}).strict();
export const DecisionSourceManifestContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionSourceManifest.v1"),
  repository: z.enum([DECISION_SOURCE_REPOSITORY, DECISION_BACKBONE_REPOSITORY]),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(DecisionSourceFileSchema).min(1).max(16),
}).strict();
export const DecisionSourceManifestSchema = DecisionSourceManifestContentSchema.extend({ contentHash: Hash });
export type DecisionSourceManifest = z.infer<typeof DecisionSourceManifestSchema>;

export const DecisionModelIdentityContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionModelIdentity.v1"),
  source: ModelProjectBaseModelSchema,
  backbone: z.object({
    architecture: z.literal("Qwen3_5ForConditionalGeneration"), modelType: z.literal("qwen3_5"),
    dtype: z.literal("bfloat16"),
    weightIdentity: z.literal("source_file_manifest_sha256_v1"),
    source: DecisionSourceManifestSchema,
  }).strict(),
  originalAdapter: DecisionSourceManifestSchema,
  tokenizer: DecisionSourceManifestSchema,
  reference: DecisionSourceManifestSchema,
  license: z.object({ spdx: z.literal("Apache-2.0"), files: z.array(DecisionSourceManifestSchema).length(2) }).strict(),
}).strict();
export const DecisionModelIdentitySchema = DecisionModelIdentityContentSchema.extend({ contentHash: Hash });
export type DecisionModelIdentity = z.infer<typeof DecisionModelIdentitySchema>;

type SourceFile = z.infer<typeof DecisionSourceFileSchema>;
const file = (path: string, sizeBytes: number, sha256: string): SourceFile => ({ path, sizeBytes, sha256 });
const backboneFiles = [
  file("config.json", 3126, "d0883072e01861ed0b2d47be3c16c36a8e81c224c7ffaa310c6558fb3f932b05"),
  file("model.safetensors.index.json", 79657, "26d3539b516be613f39563617cb9d33b3f83d401298125be392c80cefb8f7fe5"),
  file("model.safetensors-00001-of-00004.safetensors", 5276436216, "db6f444b43d318c92f360a13a25561a6a65b10c0631b8ed305a426dbaa6c380e"),
  file("model.safetensors-00002-of-00004.safetensors", 5335161512, "31c7d7e2dd5d207840b31cc59083c8f4c4718959149e0358c0364052bb9a0330"),
  file("model.safetensors-00003-of-00004.safetensors", 5368717440, "7ec36ba3a4176a44c3c0876ad80c56a2f70c84bf008d82e9501df642f17dadec"),
  file("model.safetensors-00004-of-00004.safetensors", 3325995712, "b62b0c4cd7e44edee103ee8f4fe225f246d5e768e07bfd5f25b63a8aa1fdd0c6"),
];
const adapterFiles = [
  file("adapter_config.json", 1296, "4064100b5c7c92b20b6aba8ec08af2e2a956d1fbb06263f814324301b710b3f2"),
  file("adapter_model.safetensors", 173188512, "ba7e28acb97f973e80fa51f3aa6fc6f75ea4081b89632ed45d8e5f3a1d7bfa6b"),
];
const tokenizerFiles = [
  file("chat_template.jinja", 7756, DECISION_CHAT_TEMPLATE_SHA256),
  file("tokenizer.json", 19989325, "06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523"),
  file("tokenizer_config.json", 1125, "9cf04fffe3d8c3b85e439fb35c7acad0761ab51c422a8c4256d9f887c3a0be7d"),
];
const referenceFiles = [
  file("inference.py", 5375, "95c37c0ee94b065858fcca8fe90cfa685ecde8713443c1b0555ed99012f5abfd"),
  file("parallel_schema.py", 6628, DECISION_PROMPT_CODE_SHA256),
  file("requirements.txt", 126, "7cfedd0abb35fe0b69677040ae800fa420f6c1d3162584a379785ca239ba04ea"),
  file("schema_config.json", 15838, "601c6fe561a33cbe9e88ed948503289c61c6f53876255ecb6988428824a57075"),
];
const licenseFiles = [file("LICENSE", 11544, "bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a")];

async function sourceManifest(repository: DecisionSourceManifest["repository"], revision: string, files: SourceFile[]) {
  const content = DecisionSourceManifestContentSchema.parse({
    schemaVersion: "openpond.decisionSourceManifest.v1", repository, revision, files,
  });
  return { ...content, contentHash: await canonicalSha256(content) };
}

/** Pins released source files, not a measured in-memory torch state or runtime
 * qualification. Large backbone digests originate in the exact Hub revision's
 * LFS metadata; a loader must still verify every downloaded file before use.
 * The complete conditional-generation config/index is retained, including its
 * vision and auxiliary tensors, even though this protocol supplies text only. */
export async function decisionModelIdentity(): Promise<DecisionModelIdentity> {
  const release = (files: SourceFile[]) => sourceManifest(DECISION_SOURCE_REPOSITORY, DECISION_SOURCE_REVISION, files);
  const content = DecisionModelIdentityContentSchema.parse({
    schemaVersion: "openpond.decisionModelIdentity.v1",
    source: {
      schemaVersion: "openpond.baseModelPreference.v1", modelId: DECISION_SOURCE_REPOSITORY,
      revision: DECISION_SOURCE_REVISION, tokenizerRevision: DECISION_SOURCE_REVISION,
      chatTemplateHash: DECISION_CHAT_TEMPLATE_SHA256, modelAssetId: null, source: "managed",
    },
    backbone: {
      architecture: "Qwen3_5ForConditionalGeneration", modelType: "qwen3_5", dtype: "bfloat16",
      weightIdentity: "source_file_manifest_sha256_v1",
      source: await sourceManifest(DECISION_BACKBONE_REPOSITORY, DECISION_BACKBONE_REVISION, backboneFiles),
    },
    originalAdapter: await release(adapterFiles), tokenizer: await release(tokenizerFiles),
    reference: await release(referenceFiles),
    license: { spdx: "Apache-2.0", files: [
      await sourceManifest(DECISION_BACKBONE_REPOSITORY, DECISION_BACKBONE_REVISION, licenseFiles),
      await release(licenseFiles),
    ] },
  });
  return { ...content, contentHash: await canonicalSha256(content) };
}

export async function parseAndVerifyDecisionModelIdentity(raw: unknown): Promise<DecisionModelIdentity> {
  const value = DecisionModelIdentitySchema.parse(raw);
  if (canonicalJson(value) !== canonicalJson(await decisionModelIdentity()))
    throw new OpenPondProtocolError("decision_model_identity_mismatch", "The decision Model differs from the exact released adapter, tokenizer or complete backbone source.");
  return value;
}
