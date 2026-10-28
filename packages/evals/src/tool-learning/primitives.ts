import { z } from "zod";
import {
  contentHash,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "@openpond/harness";
import { assertBoundedTaskJson } from "../task-schema-validation.js";

export const TOOL_LEARNING_LIMITS = Object.freeze({
  eventBytes: 65_536,
  actionBytes: 16_384,
  resultBytes: 8_192,
  stateBytes: 8_192,
  eventsPerAppend: 32,
  eventsPerEpisode: 256,
  episodeBytes: 2_097_152,
  assetBytes: 1_048_576,
  assetsPerEpisode: 16,
  queueBytes: 52_428_800,
  queueEvents: 5_000,
  queueAgeSeconds: 86_400,
  capabilities: 32,
  consultationRounds: 3,
  consultationBytes: 65_536,
  manifestSeconds: 300,
});

export const ToolLearningIdSchema = ReleaseIdSchema;
export const ToolLearningHashSchema = ReleaseHashSchema;
export const ToolLearningTimestampSchema = ReleaseTimestampSchema;
export const ToolLearningClientSchema = z.enum(["codex", "claude_code", "opencode", "openpond"]);
export const ToolLearningRefSchema = z
  .object({ id: ReleaseIdSchema, contentHash: ReleaseHashSchema })
  .strict();
export const ToolLearningScopeSchema = z
  .object({ teamId: ReleaseIdSchema, projectId: ReleaseIdSchema })
  .strict();

/** Run the existing non-recursive JSON bound before Zod traverses producer data. */
export function boundedToolLearningSchema<T extends z.ZodType>(schema: T, maximumBytes: number) {
  return z.preprocess((value, context) => {
    try {
      assertBoundedTaskJson(value, maximumBytes);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Tool learning data exceeds its JSON boundary.",
      });
      return z.NEVER;
    }
    return value;
  }, schema);
}

export function toolLearningText(maximumBytes: number) {
  return z
    .string()
    .max(maximumBytes)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      "Tool learning text exceeds its UTF-8 byte limit.",
    );
}

export const ToolLearningStateSchema = boundedToolLearningSchema(
  z
    .record(
      z.string().min(1).max(120),
      z.union([toolLearningText(2_000), z.number().finite(), z.boolean(), z.null()]),
    )
    .refine((value) => Object.keys(value).length <= 32, "Use at most 32 explicit state fields."),
  TOOL_LEARNING_LIMITS.stateBytes,
);

export const ToolLearningEnvironmentSchema = z
  .object({
    application: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(200),
    state: ToolLearningStateSchema,
    fingerprint: ReleaseHashSchema,
  })
  .strict();

export const ToolLearningAssetSchema = z
  .object({
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema,
    mediaType: z.enum(["text/plain", "application/json", "text/x-python", "text/x-diff"]),
    sizeBytes: z.number().int().nonnegative().max(TOOL_LEARNING_LIMITS.assetBytes),
    purpose: z.enum(["action", "result", "state", "verification"]),
  })
  .strict();

export const ToolLearningSanitizationSchema = z
  .object({
    policyRevision: z.number().int().positive(),
    policyHash: ReleaseHashSchema,
    redactedFields: z.number().int().nonnegative().max(10_000),
    omittedFields: z.number().int().nonnegative().max(10_000),
    truncated: z.boolean(),
  })
  .strict();

/** Hash only the validated public envelope; no raw hook/transcript data enters it. */
export function toolLearningContentHash(
  value: unknown,
  maximumBytes = TOOL_LEARNING_LIMITS.eventBytes,
) {
  assertBoundedTaskJson(value, maximumBytes);
  return contentHash(value);
}
