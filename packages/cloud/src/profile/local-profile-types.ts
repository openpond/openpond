import type { LocalOpenPondProfileCheckStatus } from "../config.js";

export type OpenPondProfileAgent = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
};

export type OpenPondProfileGitFileChange = {
  path: string;
  originalPath?: string | null;
  indexStatus: string | null;
  worktreeStatus: string | null;
  status: string;
  category: "added" | "modified" | "deleted" | "renamed" | "untracked" | "changed";
};

export type OpenPondProfileGitState = {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  shortHead: string | null;
  dirty: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  remoteUrl: string | null;
  files: OpenPondProfileGitFileChange[];
  error: string | null;
};

export type OpenPondProfileActionCatalogEntry = {
  id: string;
  name?: string | null;
  label?: string | null;
  description?: string | null;
  agentId?: string | null;
  sourcePath?: string | null;
  sourceActionId?: string | null;
  visibility?: string | null;
  inputSchema?: string | Record<string, unknown> | null;
  outputSchema?: string | Record<string, unknown> | null;
  approvalPolicy?: Record<string, unknown> | null;
  artifactPolicy?: Record<string, unknown> | null;
  setupRequirements?: Record<string, unknown>[];
  mcp?: Record<string, unknown> | null;
  schedulePolicy?: Record<string, unknown> | null;
  trace?: Record<string, unknown> | null;
  implementation?: Record<string, unknown> | null;
  invokesModel?: boolean;
};

export type OpenPondProfileSetupRequirement = {
  ref: string;
  source: "action_catalog" | "source_upload_metadata";
  actionId: string | null;
  kind: string | null;
  label: string;
  status: string;
  required: boolean;
  blocking: boolean;
};

export type OpenPondProfileSetupGate = {
  status: "ready" | "setup_required" | "blocked";
  requirementCount: number;
  blockingCount: number;
  optionalMissingCount: number;
  readyCount: number;
  requirements: OpenPondProfileSetupRequirement[];
  blockingRequirements: OpenPondProfileSetupRequirement[];
};

export type OpenPondProfileCatalogState = {
  actionCount: number;
  generatedAt: string | null;
  manifestPath: string | null;
  registryPath: string | null;
  stale: boolean;
  error: string | null;
};

export type OpenPondProfileDiffSummary = {
  changedAgents: string[];
  newAgents: string[];
  deletedAgents: string[];
  changedActions: string[];
  changedExtensions: string[];
  setupChanges: string[];
  envRequirementChanges: string[];
  files: OpenPondProfileGitFileChange[];
};

export type OpenPondProfileHostedBinding = {
  teamId: string | null;
  projectId: string | null;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  lastPushedAt: string | null;
  lastPushedLocalHead: string | null;
  lastPushedHostedHead: string | null;
  promotionStatus: string | null;
  hostedRunStatus: string | null;
  localGoalId: string | null;
  hostedGoalId: string | null;
  hostedRunAgentId: string | null;
  hostedRunId: string | null;
  hostedRunAt: string | null;
};

export type OpenPondProfileSummary = {
  state: "none" | "ready" | "dirty" | "pending_commit" | "error";
  message: string;
  agentCount: number;
  actionCount: number;
  defaultAction: string | null;
  checkFresh: boolean;
  checkStaleReason: string | null;
  localHead: string | null;
  hostedHead: string | null;
};

export type OpenPondProfileState = {
  mode: "none" | "local";
  repoPath: string | null;
  activeProfile: string | null;
  sourcePath: string | null;
  manifestPath: string | null;
  agents: OpenPondProfileAgent[];
  git: OpenPondProfileGitState | null;
  catalog: OpenPondProfileCatalogState;
  actionCatalog: OpenPondProfileActionCatalogEntry[];
  sourceSetupRequirements: Record<string, unknown>[];
  setupGate: OpenPondProfileSetupGate;
  diff: OpenPondProfileDiffSummary;
  hosted: OpenPondProfileHostedBinding | null;
  summary: OpenPondProfileSummary;
  lastCheck: LocalOpenPondProfileCheckStatus | null;
  error: string | null;
};

export function emptyProfileCatalogState(error: string | null = null): OpenPondProfileCatalogState {
  return {
    actionCount: 0,
    generatedAt: null,
    manifestPath: null,
    registryPath: null,
    stale: true,
    error,
  };
}

export function emptyProfileSetupGate(): OpenPondProfileSetupGate {
  return {
    status: "ready",
    requirementCount: 0,
    blockingCount: 0,
    optionalMissingCount: 0,
    readyCount: 0,
    requirements: [],
    blockingRequirements: [],
  };
}

export function emptyProfileDiffSummary(): OpenPondProfileDiffSummary {
  return {
    changedAgents: [],
    newAgents: [],
    deletedAgents: [],
    changedActions: [],
    changedExtensions: [],
    setupChanges: [],
    envRequirementChanges: [],
    files: [],
  };
}

export function emptyProfileSummary(error: string | null = null): OpenPondProfileSummary {
  return {
    state: error ? "error" : "none",
    message: error ?? "No active OpenPond profile.",
    agentCount: 0,
    actionCount: 0,
    defaultAction: null,
    checkFresh: false,
    checkStaleReason: error ?? "No active profile.",
    localHead: null,
    hostedHead: null,
  };
}
