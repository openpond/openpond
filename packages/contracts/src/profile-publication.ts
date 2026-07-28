import { z } from "zod";
import { OpenPondProfileRefSchema } from "./profile-ref.js";

export const OpenPondProfilePublicationProviderSchema = z.enum(["github", "openpond_git"]);
export const OpenPondProfilePublicationVisibilitySchema = z.enum(["private", "public"]);
export const OpenPondProfilePublicationOptionalContentSchema = z.enum([
  "actions",
  "prompts",
  "goals",
  "evals",
  "examples",
  "tasksets",
  "extensions",
]);

export const OpenPondProfilePublicationSelectionSchema = z.object({
  agentIds: z.array(z.string().trim().min(1)).max(100),
  skillNames: z.array(z.string().trim().min(1)).max(200),
  optionalContent: z.array(OpenPondProfilePublicationOptionalContentSchema).max(20).default([]),
});

export const OpenPondProfilePublicationTargetSchema = z.object({
  provider: OpenPondProfilePublicationProviderSchema,
  owner: z.string().trim().min(1).max(191).nullable().optional(),
  repository: z.string().trim().min(1).max(191),
  visibility: OpenPondProfilePublicationVisibilitySchema.default("private"),
});

export const OpenPondProfilePublicationPreviewRequestSchema = z.object({
  ref: OpenPondProfileRefSchema,
  selection: OpenPondProfilePublicationSelectionSchema,
  target: OpenPondProfilePublicationTargetSchema,
});

export const OpenPondProfilePublicationFileSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  category: z.string(),
});

export const OpenPondProfilePublicationPreviewSchema = z.object({
  sourceHash: z.string(),
  sourceRevision: z.string().nullable(),
  clean: z.boolean(),
  blockedReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  files: z.array(OpenPondProfilePublicationFileSchema),
  excludedFiles: z.array(z.string()),
  target: OpenPondProfilePublicationTargetSchema,
  replacesExisting: z.boolean(),
});

export const OpenPondProfilePublicationPublishRequestSchema =
  OpenPondProfilePublicationPreviewRequestSchema.extend({
    expectedSourceHash: z.string().trim().min(1),
    confirmed: z.literal(true),
  });

export const OpenPondProfilePublicationResultSchema = z.object({
  provider: OpenPondProfilePublicationProviderSchema,
  owner: z.string(),
  repository: z.string(),
  visibility: OpenPondProfilePublicationVisibilitySchema,
  remoteUrl: z.string(),
  webUrl: z.string(),
  revision: z.string(),
});

export type OpenPondProfilePublicationProvider = z.infer<typeof OpenPondProfilePublicationProviderSchema>;
export type OpenPondProfilePublicationVisibility = z.infer<typeof OpenPondProfilePublicationVisibilitySchema>;
export type OpenPondProfilePublicationOptionalContent =
  z.infer<typeof OpenPondProfilePublicationOptionalContentSchema>;
export type OpenPondProfilePublicationSelection = z.infer<typeof OpenPondProfilePublicationSelectionSchema>;
export type OpenPondProfilePublicationTarget = z.infer<typeof OpenPondProfilePublicationTargetSchema>;
export type OpenPondProfilePublicationPreviewRequest = z.infer<typeof OpenPondProfilePublicationPreviewRequestSchema>;
export type OpenPondProfilePublicationPreview = z.infer<typeof OpenPondProfilePublicationPreviewSchema>;
export type OpenPondProfilePublicationPublishRequest = z.infer<typeof OpenPondProfilePublicationPublishRequestSchema>;
export type OpenPondProfilePublicationResult = z.infer<typeof OpenPondProfilePublicationResultSchema>;
