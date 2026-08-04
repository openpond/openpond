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

export const AgentPackageActionSchema = z.object({
  id: z.string().trim().min(1).max(191),
  label: z.string().trim().min(1).max(160).nullable(),
  description: z.string().trim().max(1_000).nullable(),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  schedulePolicy: z.record(z.string(), z.unknown()).nullable(),
});

export const AgentPackageRuntimeRequirementsSchema = z.object({
  base: z.string().trim().min(1).max(200),
  resources: z.record(z.string(), z.unknown()),
  modelPolicy: z.record(z.string(), z.unknown()).nullable(),
  setup: z.record(z.string(), z.unknown()).nullable(),
});

export const AgentPackageReceiptSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["sdk_validation", "sdk_eval"]),
  status: z.enum(["passed", "failed"]),
  summary: z.string().trim().min(1).max(2_000),
  artifactPath: z.string().trim().min(1).max(4_096),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const AgentPackageSourceFileSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentsBase64: z.string(),
});

export const AgentPackageSchema = z.object({
  schema: z.literal("openpond.agent-package.v1"),
  agentId: z.string().trim().min(1).max(191),
  versionId: z.string().trim().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(240),
  source: z.object({
    files: z.array(AgentPackageSourceFileSchema).min(1).max(1_000),
    totalSizeBytes: z.number().int().nonnegative(),
  }),
  manifest: z.record(z.string(), z.unknown()),
  actions: z.array(AgentPackageActionSchema).min(1).max(256),
  runtimeRequirements: AgentPackageRuntimeRequirementsSchema,
  receipts: z.array(AgentPackageReceiptSchema).min(2).max(64),
});

export const AgentPackageOutputRefSchema = OutputIdentitySchema.extend({
  kind: z.literal("agent_package"),
  agentId: z.string().trim().min(1).max(191),
  versionId: z.string().trim().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  packageFileId: z.string().trim().min(1).max(200),
  manifestFileId: z.string().trim().min(1).max(200),
  actions: z.array(AgentPackageActionSchema).min(1).max(256),
  runtimeRequirements: AgentPackageRuntimeRequirementsSchema,
  validationReceiptIds: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(32),
  evalReceiptIds: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
  sourceFileCount: z.number().int().positive(),
  sourceSizeBytes: z.number().int().nonnegative(),
  location: z.discriminatedUnion("kind", [
    LocalFileOutputLocationSchema,
    ManagedFileOutputLocationSchema,
  ]),
  validation: z.array(OutputValidationEvidenceSchema).max(32).default([]),
});

export const OutputRefSchema = z.discriminatedUnion("kind", [
  FileOutputRefSchema,
  SourceChangeOutputRefSchema,
  DeploymentOutputRefSchema,
  ExternalResourceOutputRefSchema,
  AgentPackageOutputRefSchema,
]);

export const WorkOutputsResponseSchema = z.object({
  outputs: z.array(FileOutputRefSchema),
});

export type FileOutputRef = z.infer<typeof FileOutputRefSchema>;
export type LocalFileOutputRef = FileOutputRef & {
  location: z.infer<typeof LocalFileOutputLocationSchema>;
};
export type AgentPackage = z.infer<typeof AgentPackageSchema>;
export type AgentPackageAction = z.infer<typeof AgentPackageActionSchema>;
export type AgentPackageReceipt = z.infer<typeof AgentPackageReceiptSchema>;
export type AgentPackageOutputRef = z.infer<typeof AgentPackageOutputRefSchema>;
export type OutputRef = z.infer<typeof OutputRefSchema>;
export type WorkOutputsResponse = z.infer<typeof WorkOutputsResponseSchema>;

export const WORK_OUTPUT_MAX_BYTES = 10_000_000;
export const WORK_AGENT_PACKAGE_MAX_SOURCE_BYTES = 6_000_000;
export const WORKSPACE_INPUTS_DIRECTORY = "/workspace/inputs";
export const WORKSPACE_WORK_DIRECTORY = "/workspace/work";
export const WORKSPACE_OUTPUTS_DIRECTORY = "/workspace/outputs";
