import { z } from "zod";

export const LOCAL_PATH_WORKSPACE_ID_PREFIX = "local_path:";

export function localPathWorkspaceId(workspacePath: string): string {
  return `${LOCAL_PATH_WORKSPACE_ID_PREFIX}${workspacePath.trim()}`;
}

export function workspacePathFromLocalPathWorkspaceId(workspaceId: string): string | null {
  return workspaceId.startsWith(LOCAL_PATH_WORKSPACE_ID_PREFIX)
    ? workspaceId.slice(LOCAL_PATH_WORKSPACE_ID_PREFIX.length).trim() || null
    : null;
}

export const WorkspaceStateSchema = z.object({
  appId: z.string(),
  source: z.enum(["openpond", "github", "local_git", "local_folder", "unknown"]),
  workspacePath: z.string(),
  repoPath: z.string(),
  initialized: z.boolean(),
  remoteUrl: z.string().nullable(),
  expectedRemoteUrl: z.string().nullable(),
  currentBranch: z.string().nullable(),
  headCommit: z.string().nullable().optional().default(null),
  upstreamBranch: z.string().nullable().optional().default(null),
  ahead: z.number().int().nonnegative().optional().default(0),
  behind: z.number().int().nonnegative().optional().default(0),
  diverged: z.boolean().optional().default(false),
  linkedSourceHeadCommit: z.string().nullable().optional().default(null),
  aheadOfLinkedSource: z.number().int().nonnegative().optional().default(0),
  behindLinkedSource: z.number().int().nonnegative().optional().default(0),
  divergedFromLinkedSource: z.boolean().optional().default(false),
  linkedSourceComparisonError: z.string().nullable().optional().default(null),
  lastFetchAt: z.string().nullable().optional().default(null),
  defaultBranch: z.string().nullable(),
  branches: z.array(z.string()),
  dirty: z.boolean(),
  changedFilesCount: z.number(),
  untrackedFilesCount: z.number(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});

export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const WorkspaceDiffFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string(),
  content: z.string().nullable().optional().default(null),
});

export type WorkspaceDiffFile = z.infer<typeof WorkspaceDiffFileSchema>;

export const WorkspaceDiffSummarySchema = z.object({
  appId: z.string(),
  repoPath: z.string(),
  initialized: z.boolean(),
  dirty: z.boolean(),
  filesChanged: z.number(),
  additions: z.number(),
  deletions: z.number(),
  repoFiles: z.array(z.string()).optional().default([]),
  files: z.array(WorkspaceDiffFileSchema),
  error: z.string().nullable(),
  updatedAt: z.string(),
});

export type WorkspaceDiffSummary = z.infer<typeof WorkspaceDiffSummarySchema>;

export const WorkspaceBranchRequestSchema = z.object({
  branch: z.string().trim().min(1).max(160),
});

export type WorkspaceBranchRequest = z.infer<typeof WorkspaceBranchRequestSchema>;

export const SaveWorkspaceFileRequestSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
});

export type SaveWorkspaceFileRequest = z.infer<typeof SaveWorkspaceFileRequestSchema>;

export const WorkspaceLspPositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

export const WorkspaceLspRangeSchema = z.object({
  start: WorkspaceLspPositionSchema,
  end: WorkspaceLspPositionSchema,
});

export const WorkspaceLspDiagnosticSchema = z.object({
  path: z.string(),
  range: WorkspaceLspRangeSchema,
  severity: z.enum(["error", "warning", "info", "hint"]),
  message: z.string(),
  source: z.string().nullable().optional().default(null),
  code: z.string().nullable().optional().default(null),
});

export type WorkspaceLspDiagnostic = z.infer<typeof WorkspaceLspDiagnosticSchema>;

export const WorkspaceLspServerStatusSchema = z.object({
  id: z.string(),
  root: z.string(),
  status: z.enum(["connected", "unavailable", "error"]),
  message: z.string().nullable().optional().default(null),
});

export type WorkspaceLspServerStatus = z.infer<typeof WorkspaceLspServerStatusSchema>;

export const WorkspaceLspTouchRequestSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string().optional(),
  waitForDiagnostics: z.boolean().optional().default(true),
});

export type WorkspaceLspTouchRequest = z.infer<typeof WorkspaceLspTouchRequestSchema>;

export const WorkspaceLspDiagnosticsResponseSchema = z.object({
  appId: z.string(),
  path: z.string(),
  diagnostics: z.array(WorkspaceLspDiagnosticSchema),
  servers: z.array(WorkspaceLspServerStatusSchema),
  updatedAt: z.string(),
});

export type WorkspaceLspDiagnosticsResponse = z.infer<typeof WorkspaceLspDiagnosticsResponseSchema>;

export const WorkspaceLspActionRequestSchema = z.object({
  operation: z.enum(["hover", "definition", "references", "documentSymbol"]),
  path: z.string().trim().min(1),
  content: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  character: z.number().int().nonnegative().optional(),
});

export type WorkspaceLspActionRequest = z.infer<typeof WorkspaceLspActionRequestSchema>;

export const WorkspaceLspActionResponseSchema = z.object({
  appId: z.string(),
  operation: WorkspaceLspActionRequestSchema.shape.operation,
  path: z.string(),
  results: z.unknown(),
  servers: z.array(WorkspaceLspServerStatusSchema),
  updatedAt: z.string(),
});

export type WorkspaceLspActionResponse = z.infer<typeof WorkspaceLspActionResponseSchema>;

export const SidebarAppPreferenceSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  order: z.number().optional(),
});

export type SidebarAppPreference = z.infer<typeof SidebarAppPreferenceSchema>;

export const SidebarAppPreferencesSchema = z.record(z.string(), SidebarAppPreferenceSchema);

export type SidebarAppPreferences = z.infer<typeof SidebarAppPreferencesSchema>;
