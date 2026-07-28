import { z } from "zod";

const OutputIdentitySchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240),
  sourceTaskId: z.string().trim().min(1).max(200),
  sourceTurnId: z.string().trim().min(1).max(200),
  revision: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
});

export const OutputValidationEvidenceSchema = z.object({
  kind: z.enum(["structural", "visual", "test", "user_review"]),
  status: z.enum(["passed", "failed", "not_run"]),
  label: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(4_000).nullable().optional(),
  ref: z.string().trim().max(4_096).nullable().optional(),
});
export type OutputValidationEvidence = z.infer<
  typeof OutputValidationEvidenceSchema
>;

export const LocalFileOutputLocationSchema = z.object({
  kind: z.literal("local"),
  path: z.string().trim().min(1).max(4_096),
  deviceId: z.string().trim().min(1).max(200),
});

export const ManagedFileOutputLocationSchema = z.object({
  kind: z.literal("managed"),
  fileId: z.string().trim().min(1).max(200),
  downloadPath: z.string().trim().min(1).max(4_096),
});

export const ExternalFileOutputLocationSchema = z.object({
  kind: z.literal("external"),
  provider: z.string().trim().min(1).max(120),
  resourceId: z.string().trim().min(1).max(500),
  url: z.string().url().nullable(),
});

export const FileOutputRefSchema = OutputIdentitySchema.extend({
  kind: z.literal("file"),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  location: z.discriminatedUnion("kind", [
    LocalFileOutputLocationSchema,
    ManagedFileOutputLocationSchema,
    ExternalFileOutputLocationSchema,
  ]),
  validation: z.array(OutputValidationEvidenceSchema).max(32).default([]),
});

export const SourceChangeOutputRefSchema = OutputIdentitySchema.extend({
  kind: z.literal("source_change"),
  projectId: z.string().trim().min(1).max(200),
  ref: z.string().trim().min(1).max(500),
  url: z.string().url().nullable(),
  validation: z.array(OutputValidationEvidenceSchema).max(32).default([]),
});

export const DeploymentOutputRefSchema = OutputIdentitySchema.extend({
  kind: z.literal("deployment"),
  deploymentId: z.string().trim().min(1).max(200),
  url: z.string().url(),
  validation: z.array(OutputValidationEvidenceSchema).max(32).default([]),
});

export const ExternalResourceOutputRefSchema = OutputIdentitySchema.extend({
  kind: z.literal("external_resource"),
  provider: z.string().trim().min(1).max(120),
  resourceId: z.string().trim().min(1).max(500),
  url: z.string().url(),
  contentType: z.string().trim().min(1).max(200).nullable(),
  validation: z.array(OutputValidationEvidenceSchema).max(32).default([]),
});

export const OutputRefSchema = z.discriminatedUnion("kind", [
  FileOutputRefSchema,
  SourceChangeOutputRefSchema,
  DeploymentOutputRefSchema,
  ExternalResourceOutputRefSchema,
]);

export type FileOutputRef = z.infer<typeof FileOutputRefSchema>;
export type LocalFileOutputRef = FileOutputRef & {
  location: z.infer<typeof LocalFileOutputLocationSchema>;
};
export type OutputRef = z.infer<typeof OutputRefSchema>;

export const WORK_OUTPUT_MAX_BYTES = 10_000_000;
export const WORKSPACE_INPUTS_DIRECTORY = "/workspace/inputs";
export const WORKSPACE_WORK_DIRECTORY = "/workspace/work";
export const WORKSPACE_OUTPUTS_DIRECTORY = "/workspace/outputs";
