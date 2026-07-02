import type { WorkspaceToolResult } from "@openpond/contracts";
import { handleActiveWorkspaceFileAction } from "./workspace-tool-active-file-actions.js";
import { handleActiveWorkspaceGitAction } from "./workspace-tool-active-git-actions.js";
import type { ActiveWorkspaceActionContext, ActiveWorkspaceActionInput } from "./workspace-tool-active-types.js";

type ActiveWorkspaceDomainHandler = (
  context: ActiveWorkspaceActionContext
) => Promise<WorkspaceToolResult | null>;

const ACTIVE_WORKSPACE_ACTION_HANDLERS: ActiveWorkspaceDomainHandler[] = [
  handleActiveWorkspaceFileAction,
  handleActiveWorkspaceGitAction,
];

export async function handleActiveWorkspaceToolAction({
  app,
  input,
  session,
  state,
  turnId,
  withWorkspaceLock,
  refreshLocalProjectWorkspace,
  runPostEditChecks,
  runPostEditWorkflow,
}: ActiveWorkspaceActionInput): Promise<WorkspaceToolResult> {
  const args = input.args;
  const runChecks = args.runChecks !== false;

  return withWorkspaceLock(app.id, async () => {
    const context: ActiveWorkspaceActionContext = {
      app,
      args,
      input,
      runChecks,
      session,
      state,
      turnId,
      refreshLocalProjectWorkspace,
      runPostEditChecks,
      runPostEditWorkflow,
    };

    for (const handler of ACTIVE_WORKSPACE_ACTION_HANDLERS) {
      const result = await handler(context);
      if (result) return result;
    }

    throw new Error(`Unsupported workspace tool: ${input.action}`);
  });
}
