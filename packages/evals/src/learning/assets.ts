import { z } from "zod";
import { ImmutableAssetRefSchema, ReleaseHashSchema, ReleaseIdSchema, contentHash, sha256, type ImmutableAssetRef } from "@openpond/harness";
import { assertBoundedTaskJson } from "../task-schema.js";
import { LearningDomainError } from "./errors.js";

/** Small authored source files. Large binary evidence uses the host asset API. */
export const LearningTextAssetContentSchema = z.object({
  schemaVersion: z.literal("openpond.learningTextAsset.v1"),
  id: ReleaseIdSchema,
  revision: z.literal(1),
  asset: ImmutableAssetRefSchema,
  text: z.string().max(524_288),
}).strict().superRefine((value, context) => {
  if (value.asset.id !== value.id) context.addIssue({ code: "custom", path: ["asset", "id"], message: "Asset identity must match the stored resource." });
  if (value.asset.sizeBytes !== new TextEncoder().encode(value.text).byteLength || value.asset.sizeBytes > 524_288) context.addIssue({ code: "custom", path: ["asset", "sizeBytes"], message: "Authored source must match its byte count and fit within 512 KiB." });
  if (value.asset.contentHash !== sha256(value.text)) context.addIssue({ code: "custom", path: ["asset", "contentHash"], message: "Asset source does not match its SHA-256." });
});
export const LearningTextAssetSchema = LearningTextAssetContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();
export type LearningTextAsset = z.infer<typeof LearningTextAssetSchema>;

export function createLearningTextAsset(input: { text: string; path: string; mediaType: string; visibility: ImmutableAssetRef["visibility"] }): LearningTextAsset {
  assertBoundedTaskJson(input);
  const { text, ...attributes } = input;
  const hash = sha256(text);
  const id = `asset-${hash}-${contentHash(attributes).slice(0, 16)}`;
  const content = LearningTextAssetContentSchema.parse({
    schemaVersion: "openpond.learningTextAsset.v1", id, revision: 1,
    asset: { ...attributes, id, contentHash: hash, sizeBytes: new TextEncoder().encode(text).byteLength }, text,
  });
  return LearningTextAssetSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyLearningTextAsset(asset: LearningTextAsset, reference: ImmutableAssetRef): string {
  const { contentHash: hash, ...content } = LearningTextAssetSchema.parse(asset);
  if (contentHash(content) !== hash || contentHash(content.asset) !== contentHash(reference)) throw new LearningDomainError("learning_asset_reference_mismatch", 409);
  return content.text;
}
