import { z } from "zod";
import { OpenPondActionCatalogEntrySchema } from "./requests.js";

export const LocalOpenPondProfileCheckStatusSchema = z.object({
  command: z.enum(["inspect", "build", "validate", "eval", "run"]),
  status: z.enum(["passed", "failed"]),
  checkedAt: z.string(),
  exitCode: z.number().nullable().optional(),
  sourceHead: z.string().nullable().optional(),
});

export const OpenPondProfileAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  enabled: z.boolean(),
});

export const OpenPondProfileGitFileChangeSchema = z.object({
  path: z.string(),
  originalPath: z.string().nullable().optional(),
  indexStatus: z.string().nullable(),
  worktreeStatus: z.string().nullable(),
  status: z.string(),
  category: z.enum(["added", "modified", "deleted", "renamed", "untracked", "changed"]),
});

export const OpenPondProfileGitStateSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  shortHead: z.string().nullable(),
  dirty: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  files: z.array(OpenPondProfileGitFileChangeSchema),
  error: z.string().nullable(),
});

export const OpenPondProfileCatalogStateSchema = z.object({
  actionCount: z.number(),
  generatedAt: z.string().nullable(),
  manifestPath: z.string().nullable(),
  registryPath: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
});

export const OpenPondProfileSetupRequirementSchema = z.object({
  ref: z.string(),
  source: z.enum(["action_catalog", "source_upload_metadata"]),
  actionId: z.string().nullable(),
  kind: z.string().nullable(),
  label: z.string(),
  status: z.string(),
  required: z.boolean(),
  blocking: z.boolean(),
});

export const OpenPondProfileSetupGateSchema = z.object({
  status: z.enum(["ready", "setup_required", "blocked"]),
  requirementCount: z.number(),
  blockingCount: z.number(),
  optionalMissingCount: z.number(),
  readyCount: z.number(),
  requirements: z.array(OpenPondProfileSetupRequirementSchema),
  blockingRequirements: z.array(OpenPondProfileSetupRequirementSchema),
});

export const OpenPondProfileDiffSummarySchema = z.object({
  changedAgents: z.array(z.string()),
  newAgents: z.array(z.string()),
  deletedAgents: z.array(z.string()),
  changedActions: z.array(z.string()),
  changedExtensions: z.array(z.string()),
  setupChanges: z.array(z.string()),
  envRequirementChanges: z.array(z.string()),
  files: z.array(OpenPondProfileGitFileChangeSchema),
});

export const OpenPondProfileHostedBindingSchema = z.object({
  teamId: z.string().nullable(),
  projectId: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sourceCommitSha: z.string().nullable(),
  lastPushedAt: z.string().nullable(),
  lastPushedLocalHead: z.string().nullable(),
  lastPushedHostedHead: z.string().nullable(),
  promotionStatus: z.string().nullable().optional().default(null),
  hostedRunStatus: z.string().nullable().optional().default(null),
  localGoalId: z.string().nullable().optional().default(null),
  hostedGoalId: z.string().nullable().optional().default(null),
  hostedRunAgentId: z.string().nullable().optional().default(null),
  hostedRunId: z.string().nullable().optional().default(null),
  hostedRunAt: z.string().nullable().optional().default(null),
});

export const OpenPondProfileSummarySchema = z.object({
  state: z.enum(["none", "ready", "dirty", "pending_commit", "error"]),
  message: z.string(),
  agentCount: z.number(),
  actionCount: z.number(),
  defaultAction: z.string().nullable(),
  checkFresh: z.boolean(),
  checkStaleReason: z.string().nullable(),
  localHead: z.string().nullable(),
  hostedHead: z.string().nullable(),
});

export const OpenPondProfileStateSchema = z.object({
  mode: z.enum(["none", "local"]),
  repoPath: z.string().nullable(),
  activeProfile: z.string().nullable(),
  sourcePath: z.string().nullable(),
  manifestPath: z.string().nullable(),
  agents: z.array(OpenPondProfileAgentSchema),
  git: OpenPondProfileGitStateSchema.nullable(),
  catalog: OpenPondProfileCatalogStateSchema,
  actionCatalog: z.array(OpenPondActionCatalogEntrySchema),
  sourceSetupRequirements: z.array(z.record(z.string(), z.unknown())),
  setupGate: OpenPondProfileSetupGateSchema,
  diff: OpenPondProfileDiffSummarySchema,
  hosted: OpenPondProfileHostedBindingSchema.nullable(),
  summary: OpenPondProfileSummarySchema,
  lastCheck: LocalOpenPondProfileCheckStatusSchema.nullable(),
  error: z.string().nullable(),
});

export type LocalOpenPondProfileCheckStatus = z.infer<typeof LocalOpenPondProfileCheckStatusSchema>;
export type OpenPondProfileAgent = z.infer<typeof OpenPondProfileAgentSchema>;
export type OpenPondProfileGitFileChange = z.infer<typeof OpenPondProfileGitFileChangeSchema>;
export type OpenPondProfileGitState = z.infer<typeof OpenPondProfileGitStateSchema>;
export type OpenPondProfileCatalogState = z.infer<typeof OpenPondProfileCatalogStateSchema>;
export type OpenPondProfileSetupRequirement = z.infer<typeof OpenPondProfileSetupRequirementSchema>;
export type OpenPondProfileSetupGate = z.infer<typeof OpenPondProfileSetupGateSchema>;
export type OpenPondProfileDiffSummary = z.infer<typeof OpenPondProfileDiffSummarySchema>;
export type OpenPondProfileHostedBinding = z.infer<typeof OpenPondProfileHostedBindingSchema>;
export type OpenPondProfileSummary = z.infer<typeof OpenPondProfileSummarySchema>;
export type OpenPondProfileState = z.infer<typeof OpenPondProfileStateSchema>;

export function emptyOpenPondProfileState(): OpenPondProfileState {
  return {
    mode: "none",
    repoPath: null,
    activeProfile: null,
    sourcePath: null,
    manifestPath: null,
    agents: [],
    git: null,
    catalog: {
      actionCount: 0,
      generatedAt: null,
      manifestPath: null,
      registryPath: null,
      stale: true,
      error: null,
    },
    actionCatalog: [],
    sourceSetupRequirements: [],
    setupGate: {
      status: "ready",
      requirementCount: 0,
      blockingCount: 0,
      optionalMissingCount: 0,
      readyCount: 0,
      requirements: [],
      blockingRequirements: [],
    },
    diff: {
      changedAgents: [],
      newAgents: [],
      deletedAgents: [],
      changedActions: [],
      changedExtensions: [],
      setupChanges: [],
      envRequirementChanges: [],
      files: [],
    },
    hosted: null,
    summary: {
      state: "none",
      message: "No active OpenPond profile.",
      agentCount: 0,
      actionCount: 0,
      defaultAction: null,
      checkFresh: false,
      checkStaleReason: "No active profile.",
      localHead: null,
      hostedHead: null,
    },
    lastCheck: null,
    error: null,
  };
}
