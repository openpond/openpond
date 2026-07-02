import type { LocalProject, OpenPondApp, RuntimeEvent, WorkspaceDiffSummary } from "@openpond/contracts";
import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { createWorkspaceManagedWorkflows } from "./server-workspace-managed-workflows.js";
import { createWorkspaceSessionWorkflows } from "./server-workspace-session-workflows.js";

export function createServerWorkspaceWorkflows(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  checkpointDiffQueue: BackgroundWorkerQueue;
  findLocalWorkspace: (projectId: string) => Promise<LocalProject | null>;
  findOpenPondApp: (appId: string) => Promise<OpenPondApp>;
  storeDir: string;
  workspaceDiffPayload: (appId: string) => Promise<WorkspaceDiffSummary>;
}) {
  const sessionWorkflows = createWorkspaceSessionWorkflows({
    appendRuntimeEvent: deps.appendRuntimeEvent,
    checkpointDiffQueue: deps.checkpointDiffQueue,
    findLocalWorkspace: deps.findLocalWorkspace,
    findOpenPondApp: deps.findOpenPondApp,
    storeDir: deps.storeDir,
    workspaceDiffPayload: deps.workspaceDiffPayload,
  });
  const managedWorkflows = createWorkspaceManagedWorkflows({
    appendRuntimeEvent: deps.appendRuntimeEvent,
  });

  return {
    ...sessionWorkflows,
    ...managedWorkflows,
  };
}
