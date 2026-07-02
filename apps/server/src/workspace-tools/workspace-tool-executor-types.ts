import type {
  AccountState,
  LocalProject,
  OpenPondApp,
  RuntimeEvent,
  Session,
  WorkspaceDiffSummary,
  WorkspaceState,
  WorkspaceToolRequest,
} from "@openpond/contracts";
import type { loadOpenPondAccountContext } from "@openpond/runtime";
import type { CheckResult } from "./workspace-tool-common.js";

export type WorkspaceToolLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type WorkspaceCheckResult = CheckResult;
export type WorkspaceToolSource = WorkspaceToolRequest["source"];

export type EditWorkflowInput = {
  session: Session;
  app: OpenPondApp;
  state: WorkspaceState;
  turnId?: string;
  source: WorkspaceToolSource;
  args: Record<string, unknown>;
  runChecks: boolean;
};

export type ConfigWorkflowInput = Omit<EditWorkflowInput, "args">;

export type WorkflowResult = {
  ok: boolean;
  checks: WorkspaceCheckResult[];
  managed: Record<string, unknown> | null;
};

export type WorkspaceToolExecutorDeps = {
  logger: WorkspaceToolLogger;
  truncateLogValue: (value: unknown) => unknown;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  appendWorkspaceDiffEvent: (
    session: Session,
    turnId: string,
    options?: { baseline?: WorkspaceDiffSummary | null }
  ) => Promise<void>;
  getSession: (sessionId: string) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  findLocalWorkspace: (projectId: string) => Promise<LocalProject | null>;
  refreshLocalProjectWorkspace: (projectId: string) => Promise<LocalProject>;
  linkLocalProjectOpenPondApp: (
    projectId: string,
    app: OpenPondApp,
    options?: { repoPath?: string | null }
  ) => Promise<LocalProject>;
  activeWorkspace: (session: Session) => Promise<{ app: OpenPondApp; state: WorkspaceState }>;
  withWorkspaceLock: <T>(appId: string, fn: () => Promise<T>) => Promise<T>;
  runPostEditChecks: (
    session: Session,
    turnId: string | undefined,
    source: WorkspaceToolSource,
    repoPath: string
  ) => Promise<WorkspaceCheckResult[]>;
  runPostEditWorkflow: (input: EditWorkflowInput) => Promise<WorkflowResult>;
  openPondCacheScope: (accountState: AccountState) => string;
  upsertScaffoldApp: (scope: string, app: OpenPondApp) => Promise<void>;
  gitBaseUrlFromContext: (context: Awaited<ReturnType<typeof loadOpenPondAccountContext>>) => string | null;
};
