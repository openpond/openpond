import { z } from "zod";
import {
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
} from "./create-pipeline.js";

import {
  SandboxTemplateManifestSchema,
  SandboxTemplateValidationDiagnosticSchema,
} from "./sandbox-template.js";

export const AppScheduleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    scheduleType: z.string(),
    scheduleExpression: z.string(),
    enabled: z.boolean(),
    rawEnabled: z.boolean().optional(),
    syncStatus: z.string().nullable(),
    syncError: z.string().nullable().optional(),
    startAt: z.string().nullable(),
    endAt: z.string().nullable(),
    maxRuns: z.number().nullable(),
    executionCount: z.number().nullable(),
    lifecycleStatus: z.string().nullable(),
    lifecycleReason: z.string().nullable(),
    lastExecutionAt: z.string().nullable().optional(),
    lastExecutionStatus: z.string().nullable().optional(),
    lastRunNowAt: z.string().nullable().optional(),
    lastRunNowStatus: z.string().nullable().optional(),
    updatedAt: z.string(),
    deploymentId: z.string(),
    isProduction: z.boolean().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

export type AppSchedule = z.infer<typeof AppScheduleSchema>;

export const AppScheduleSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    enabled: z.number().int().nonnegative().optional(),
    disabled: z.number().int().nonnegative().optional(),
    nextRunAt: z.string().nullable().optional(),
    lastRunAt: z.string().nullable().optional(),
    schedules: z.array(AppScheduleSchema).optional().default([]),
    truncated: z.boolean().optional(),
  })
  .passthrough();

export type AppScheduleSummary = z.infer<typeof AppScheduleSummarySchema>;

export const SandboxAppActionRegistryEntrySchema = z
  .object({
    name: z.string(),
    kind: z.enum(["start", "action", "service"]),
    command: z.string(),
    cwd: z.string().nullable(),
    timeoutSeconds: z.number().nullable(),
    requiresStart: z.boolean(),
    ports: z
      .array(
        z
          .object({
            port: z.number(),
            protocol: z.string(),
            label: z.string().nullable(),
            access: z.string(),
            path: z.string(),
          })
          .passthrough()
      )
      .default([]),
    artifactPaths: z.array(z.string()).default([]),
  })
  .passthrough();

export const SandboxAppActionRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("openpond.yaml"),
    manifestName: z.string(),
    manifestVersion: z.string(),
    manifestUseCase: z.string(),
    manifestDescription: z.string(),
    manifestPath: z.string(),
    manifestHash: z.string(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    env: z
      .array(
        z
          .object({
            name: z.string(),
            required: z.boolean(),
            secret: z.boolean(),
            description: z.string().nullable(),
          })
          .passthrough()
      )
      .default([]),
    start: SandboxAppActionRegistryEntrySchema,
    actions: z.array(SandboxAppActionRegistryEntrySchema).default([]),
    services: z.array(SandboxAppActionRegistryEntrySchema).default([]),
    defaultActionName: z.string().nullable(),
    updatedAt: z.string(),
  })
  .passthrough();

export type SandboxAppActionRegistry = z.infer<typeof SandboxAppActionRegistrySchema>;

export const OpenPondAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.string().nullable().optional(),
  gitOwner: z.string().nullable().optional(),
  gitRepo: z.string().nullable().optional(),
  gitHost: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  sandbox: z.boolean().optional().default(false),
  sandboxActionRegistry: SandboxAppActionRegistrySchema.nullable().optional(),
  sandboxManifestHash: z.string().nullable().optional(),
  sandboxManifestPath: z.string().nullable().optional(),
  sandboxManifestSyncedAt: z.string().nullable().optional(),
  sandboxManifestError: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  latestDeployment: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      deploymentDomain: z.string().nullable().optional(),
      createdAt: z.string().optional(),
      isProduction: z.boolean().nullable().optional(),
      gitBranch: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  scheduleSummary: AppScheduleSummarySchema.nullable().optional(),
});

export type OpenPondApp = z.infer<typeof OpenPondAppSchema>;

export const LocalProjectSandboxTemplateSchema = z.object({
  detected: z.boolean(),
  rootPath: z.string(),
  manifestPath: z.string(),
  manifestHash: z.string().nullable().optional().default(null),
  manifest: z.record(z.string(), z.unknown()).nullable().optional().default(null),
  normalizedManifest: SandboxTemplateManifestSchema.nullable().optional().default(null),
  valid: z.boolean().optional().default(false),
  diagnostics: z.array(SandboxTemplateValidationDiagnosticSchema).optional().default([]),
});

export type LocalProjectSandboxTemplate = z.infer<typeof LocalProjectSandboxTemplateSchema>;

export const LocalProjectOpenPondLinkSchema = z.object({
  appId: z.string(),
  appName: z.string(),
  gitOwner: z.string().nullable(),
  gitRepo: z.string().nullable(),
  gitHost: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  linkedAt: z.string(),
});

export type LocalProjectOpenPondLink = z.infer<typeof LocalProjectOpenPondLinkSchema>;

export const LocalProjectSandboxProjectLinkSchema = z.object({
  teamId: z.string(),
  projectId: z.string(),
  projectSlug: z.string().nullable().optional().default(null),
  projectName: z.string().nullable().optional().default(null),
  sourceRepoUrl: z.string().nullable().optional().default(null),
  defaultBranch: z.string().nullable().optional().default(null),
  lastUploadedCommit: z.string().nullable().optional().default(null),
  lastUploadTransport: z.enum(["git_head", "snapshot", "api_source_upload"]).nullable().optional().default(null),
  manifestPath: z.string().nullable().optional().default(null),
  manifestHash: z.string().nullable().optional().default(null),
  syncedAt: z.string().nullable().optional().default(null),
  linkedAt: z.string(),
});

export type LocalProjectSandboxProjectLink = z.infer<typeof LocalProjectSandboxProjectLinkSchema>;

export const ProjectAgentSdkDependencyTypeSchema = z.enum([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

export type ProjectAgentSdkDependencyType = z.infer<typeof ProjectAgentSdkDependencyTypeSchema>;

export const ProjectAgentSdkSchema = z.object({
  detected: z.boolean(),
  packageName: z.string().optional().default("openpond-agent-sdk"),
  rootPath: z.string().nullable().optional().default(null),
  manifestPath: z.string().nullable().optional().default(null),
  version: z.string().nullable().optional().default(null),
  dependencyType: ProjectAgentSdkDependencyTypeSchema.nullable().optional().default(null),
});

export type ProjectAgentSdk = z.infer<typeof ProjectAgentSdkSchema>;

export const CloudProjectSourceTypeSchema = z.enum(["github_repo", "internal_repo", "template", "manual"]);

export type CloudProjectSourceType = z.infer<typeof CloudProjectSourceTypeSchema>;

export const CloudProjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional().default(null),
  sourceType: CloudProjectSourceTypeSchema.optional().default("manual"),
  sourceLabel: z.string().nullable().optional().default(null),
  defaultBranch: z.string().nullable().optional().default(null),
  internalRepoPath: z.string().nullable().optional().default(null),
  manifestPath: z.string().nullable().optional().default(null),
  manifestHash: z.string().nullable().optional().default(null),
  syncedAt: z.string().nullable().optional().default(null),
  agentSdk: ProjectAgentSdkSchema.nullable().optional(),
  organizationName: z.string().nullable().optional().default(null),
  organizationSlug: z.string().nullable().optional().default(null),
  createdAt: z.string().nullable().optional().default(null),
  updatedAt: z.string().nullable().optional().default(null),
});

export type CloudProject = z.infer<typeof CloudProjectSchema>;

export const CloudWorkItemStatusSchema = z.enum([
  "backlog",
  "queued",
  "running",
  "needs_review",
  "done",
  "failed",
  "cancelled",
]);

export type CloudWorkItemStatus = z.infer<typeof CloudWorkItemStatusSchema>;

export const CloudWorkItemSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  conversationId: z.string().nullable().optional().default(null),
  title: z.string(),
  status: CloudWorkItemStatusSchema,
  sourceRef: z.string().nullable().optional().default(null),
  baseSha: z.string().nullable().optional().default(null),
  latestRuntimeId: z.string().nullable().optional().default(null),
  latestSandboxId: z.string().nullable().optional().default(null),
  latestTaskRunId: z.string().nullable().optional().default(null),
  assignedAgentId: z.string().nullable().optional().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().optional().default(null),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createPipelineRequest: CreatePipelineRequestSchema.nullable().optional().default(null),
  createPipeline: CreatePipelineSnapshotSchema.nullable().optional().default(null),
});

export type CloudWorkItem = z.infer<typeof CloudWorkItemSchema>;

export const CloudWorkItemMessageSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "task", "runtime"]),
  body: z.string(),
  createdByUserId: z.string().nullable().optional().default(null),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type CloudWorkItemMessage = z.infer<typeof CloudWorkItemMessageSchema>;

export const CloudWorkItemActivitySchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  kind: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type CloudWorkItemActivity = z.infer<typeof CloudWorkItemActivitySchema>;

export const CloudWorkItemRuntimeSessionSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  runtimeId: z.string(),
  runtimeProfileId: z.string(),
  sandboxId: z.string().nullable().optional().default(null),
  kind: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional().default(null),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type CloudWorkItemRuntimeSession = z.infer<
  typeof CloudWorkItemRuntimeSessionSchema
>;

export const CloudWorkItemDetailSchema = z.object({
  workItem: CloudWorkItemSchema,
  messages: z.array(CloudWorkItemMessageSchema).default([]),
  activity: z.array(CloudWorkItemActivitySchema).default([]),
  runtimeSessions: z.array(CloudWorkItemRuntimeSessionSchema).default([]),
  createPipelineRequest: CreatePipelineRequestSchema.nullable().optional().default(null),
  createPipeline: CreatePipelineSnapshotSchema.nullable().optional().default(null),
});

export type CloudWorkItemDetail = z.infer<typeof CloudWorkItemDetailSchema>;

export const LocalProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  workspacePath: z.string(),
  repoPath: z.string().nullable(),
  source: z.enum(["folder", "git"]),
  systemKind: z.enum(["openpond.insights"]).nullable().optional(),
  hiddenFromDefaultSidebar: z.boolean().optional(),
  sandboxTemplate: LocalProjectSandboxTemplateSchema.nullable().optional().default(null),
  agentSdk: ProjectAgentSdkSchema.nullable().optional(),
  linkedOpenPondApp: LocalProjectOpenPondLinkSchema.nullable().optional().default(null),
  linkedSandboxProject: LocalProjectSandboxProjectLinkSchema.nullable().optional().default(null),
  preferredSandboxAgentId: z.string().nullable().optional().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type LocalProject = z.infer<typeof LocalProjectSchema>;

export const CreateLocalProjectRequestSchema = z
  .object({
    path: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    createNew: z.boolean().optional(),
    baseDirectory: z.string().trim().min(1).max(4096).optional(),
  })
  .superRefine((value, context) => {
    if (value.createNew) {
      if (!value.name?.trim()) {
        context.addIssue({
          code: "custom",
          path: ["name"],
          message: "Project name is required when creating a new project.",
        });
      }
      return;
    }
    if (!value.path?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "Project path is required.",
      });
    }
  });

export type CreateLocalProjectRequest = z.infer<typeof CreateLocalProjectRequestSchema>;

export const UpdateLocalProjectAgentSetupRequestSchema = z.object({
  linkedSandboxProject: LocalProjectSandboxProjectLinkSchema.nullable().optional(),
  preferredSandboxAgentId: z.string().nullable().optional(),
  hiddenFromDefaultSidebar: z.boolean().optional(),
});

export type UpdateLocalProjectAgentSetupRequest = z.infer<
  typeof UpdateLocalProjectAgentSetupRequestSchema
>;
