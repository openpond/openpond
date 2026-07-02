import type {
  OpenPondApp,
  Session,
  WorkspaceState,
  WorkspaceToolRequest,
} from "@openpond/contracts";
import type { WorkspaceToolExecutorDeps } from "./workspace-tool-executor-types.js";

export type ActiveWorkspaceActionInput = {
  app: OpenPondApp;
  input: WorkspaceToolRequest;
  session: Session;
  state: WorkspaceState;
  turnId?: string;
  withWorkspaceLock: WorkspaceToolExecutorDeps["withWorkspaceLock"];
  refreshLocalProjectWorkspace: WorkspaceToolExecutorDeps["refreshLocalProjectWorkspace"];
  runPostEditChecks: WorkspaceToolExecutorDeps["runPostEditChecks"];
  runPostEditWorkflow: WorkspaceToolExecutorDeps["runPostEditWorkflow"];
};

export type ActiveWorkspaceActionContext = Omit<ActiveWorkspaceActionInput, "withWorkspaceLock"> & {
  args: Record<string, unknown>;
  runChecks: boolean;
};
