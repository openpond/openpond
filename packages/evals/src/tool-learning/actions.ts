import { z } from "zod";
import {
  TOOL_LEARNING_LIMITS,
  ToolLearningHashSchema,
  boundedToolLearningSchema,
  toolLearningText,
} from "./primitives.js";

const Text = toolLearningText(TOOL_LEARNING_LIMITS.actionBytes);
const RelativePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/^[A-Za-z]:/u.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a workspace-relative artifact path.",
  );

export const ToolLearningActionSchema = boundedToolLearningSchema(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("python"), code: Text }).strict(),
    z
      .object({ kind: z.literal("shell"), command: Text, shell: z.string().min(1).max(120) })
      .strict(),
    z
      .object({
        kind: z.literal("tool_arguments"),
        arguments: z.record(z.string().min(1).max(200), z.json()),
      })
      .strict(),
    z
      .object({
        kind: z.literal("edit"),
        patch: Text,
        baseFiles: z
          .array(
            z
              .object({ path: RelativePath, contentHash: ToolLearningHashSchema.nullable() })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict(),
  ]),
  TOOL_LEARNING_LIMITS.actionBytes,
);
export type ToolLearningAction = z.infer<typeof ToolLearningActionSchema>;

export const ToolLearningRepairSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replacement"),
      expectedActionHash: ToolLearningHashSchema,
      environmentFingerprint: ToolLearningHashSchema,
      action: ToolLearningActionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("patch"),
      expectedActionHash: ToolLearningHashSchema,
      environmentFingerprint: ToolLearningHashSchema,
      files: z
        .array(
          z
            .object({
              path: RelativePath,
              expectedContentHash: ToolLearningHashSchema,
              patch: Text,
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
]);
export type ToolLearningRepair = z.infer<typeof ToolLearningRepairSchema>;
