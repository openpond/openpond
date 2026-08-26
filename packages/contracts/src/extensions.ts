import { z } from "zod";

export const SHIPPED_OPENPOND_SKILL_NAMES = [
  "openpond-cli",
  "openpond-desktop-harness",
  "openpond-taskset-authoring",
  "openpond-skill-authoring",
  "openpond-agent-authoring",
  "openpond-refiner-authoring",
] as const;

export const BUILT_IN_OPENPOND_PROFILE_SKILLS = [
  {
    name: "openpond-taskset-authoring",
    description:
      "Create, improve, inspect, test, or prepare an OpenPond Taskset from a capability, Profile Agent, consented evidence, or imported data.",
    path: "skills/openpond-taskset-authoring/SKILL.md",
    scope: "profile" as const,
    enabled: true,
    sourcePath: "bundled://openpond",
    charCount: 0,
    sourceHash: "bundled",
    validationStatus: "valid" as const,
    validationMessages: [],
    resourceFiles: [
      "references/task-design.md",
      "references/graders-and-rewards.md",
      "references/method-selection.md",
      "references/privacy-and-provenance.md",
    ],
  },
  {
    name: "openpond-skill-authoring",
    description:
      "Create, copy, adapt, review, or update OpenPond Profile skill packages from slash commands or ordinary authoring requests.",
    path: "skills/openpond-skill-authoring/SKILL.md",
    scope: "profile" as const,
    enabled: true,
    sourcePath: "bundled://openpond",
    charCount: 0,
    sourceHash: "bundled",
    validationStatus: "valid" as const,
    validationMessages: [],
    resourceFiles: [
      "references/skill-package-layout.md",
      "references/copying-and-adaptation.md",
      "references/validation-and-repair.md",
      "scripts/validate-skill.mjs",
    ],
  },
  {
    name: "openpond-agent-authoring",
    description:
      "Create, improve, review, or repair source-backed OpenPond Profile Agents and Agent SDK projects.",
    path: "skills/openpond-agent-authoring/SKILL.md",
    scope: "profile" as const,
    enabled: true,
    sourcePath: "bundled://openpond",
    charCount: 0,
    sourceHash: "bundled",
    validationStatus: "valid" as const,
    validationMessages: [],
    resourceFiles: [
      "references/profile-layout.md",
      "references/action-and-chat-design.md",
      "references/integrations-and-setup.md",
      "references/validation-and-repair.md",
    ],
  },
  {
    name: "openpond-refiner-authoring",
    description:
      "Inspect, extend, validate, activate, or roll back the OpenPond Refiner Review Profile without changing the Refiner Core.",
    path: "skills/openpond-refiner-authoring/SKILL.md",
    scope: "profile" as const,
    enabled: true,
    sourcePath: "bundled://openpond",
    charCount: 0,
    sourceHash: "bundled",
    validationStatus: "valid" as const,
    validationMessages: [],
    resourceFiles: [
      "references/review-profile.md",
      "references/core-boundary.md",
      "references/validation-and-activation.md",
    ],
  },
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
