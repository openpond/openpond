import { z } from "zod";

export const SHIPPED_OPENPOND_SKILL_NAMES = [
  "openpond-cli",
  "openpond-desktop-harness",
  "openpond-taskset-authoring",
] as const;

export const OpenPondExtensionSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  relativePath: z.string(),
  sourcePath: z.string(),
  charCount: z.number().int().nonnegative(),
  sourceHash: z.string(),
  resourceFiles: z.array(z.string()),
  validationStatus: z.enum(["valid", "error"]),
  validationMessages: z.array(z.string()),
});

export const OpenPondExtensionSchema = z.object({
  id: z.string(),
  source: z.literal("github"),
  owner: z.string(),
  repo: z.string(),
  repositoryUrl: z.string().url(),
  requestedRef: z.string(),
  resolvedCommit: z.string(),
  sourcePath: z.string(),
  readmePath: z.string().nullable(),
  installedAt: z.string(),
  updatedAt: z.string(),
  packageHash: z.string(),
  skills: z.array(OpenPondExtensionSkillSchema),
  validationStatus: z.enum(["valid", "error"]),
  validationMessages: z.array(z.string()),
});

export const OpenPondExtensionPreviewSchema = OpenPondExtensionSchema.omit({
  installedAt: true,
  updatedAt: true,
  sourcePath: true,
}).extend({
  sourcePath: z.null(),
});

export const OpenPondExtensionCatalogSchema = z.object({
  rootPath: z.string(),
  registryPath: z.string(),
  extensions: z.array(OpenPondExtensionSchema),
  error: z.string().nullable(),
});

export const OpenPondExtensionSourceRequestSchema = z.object({
  source: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
});

export type OpenPondExtensionSkill = z.infer<typeof OpenPondExtensionSkillSchema>;
export type OpenPondExtension = z.infer<typeof OpenPondExtensionSchema>;
export type OpenPondExtensionPreview = z.infer<typeof OpenPondExtensionPreviewSchema>;
export type OpenPondExtensionCatalog = z.infer<typeof OpenPondExtensionCatalogSchema>;
export type OpenPondExtensionSourceRequest = z.infer<typeof OpenPondExtensionSourceRequestSchema>;
