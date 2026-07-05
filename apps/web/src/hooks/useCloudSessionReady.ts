import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BootstrapPayload,
  CloudProject,
  LocalProject,
  Session,
  WorkspaceState,
} from "@openpond/contracts";
import { type ClientConnection } from "../api";
import type { ShowAppToast } from "../app/app-state";
import {
  ensureCloudWorkspaceRunning,
  type CloudWorkspaceReadyStatus,
} from "../lib/cloud-workspace-lifecycle";
import { isHybridWorkspaceSession } from "../lib/workspace-location";

export function cloudWorkspaceStartingMessage(session: Session): string {
  return isHybridWorkspaceSession(session)
    ? "Preparing Hybrid sandbox..."
    : "Starting Cloud workspace...";
}

export function cloudWorkspaceReadyMessage(
  status: CloudWorkspaceReadyStatus,
  session: Session,
): string | null {
  if (status === "already_running") return null;
  const target = isHybridWorkspaceSession(session) ? "Hybrid sandbox" : "Cloud workspace";
  if (status === "waited_for_creating") return `${target} is ready.`;
  if (status === "started") return `Started ${target}.`;
  if (status === "resumed") return `Resumed ${target}.`;
  if (status === "restored") return `Restored ${target}.`;
  return `Recreated ${target}.`;
}

export function useCloudSessionReady({
  applyBootstrapPayload,
  connection,
  localProjectById,
  selectedCloudProject,
  selectedProject,
  setWorkspaceBusy,
  showToast,
  visibleWorkspaceState,
}: {
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  connection: ClientConnection | null;
  localProjectById: Map<string, LocalProject>;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
  showToast: ShowAppToast;
  visibleWorkspaceState: WorkspaceState | null;
}) {
  return useCallback(
    async (session: Session): Promise<Session> => {
      if (!connection) throw new Error("OpenPond App server is not connected.");
      const localProject =
        selectedProject ??
        (session.localProjectId ? (localProjectById.get(session.localProjectId) ?? null) : null);
      if (!session.workspaceId) showToast(cloudWorkspaceStartingMessage(session), "info");
      setWorkspaceBusy(true);
      try {
        const result = await ensureCloudWorkspaceRunning({
          branch:
            selectedProject?.linkedSandboxProject?.defaultBranch ??
            selectedCloudProject?.defaultBranch ??
            visibleWorkspaceState?.currentBranch ??
            null,
          connection,
          localProject,
          session,
          source: isHybridWorkspaceSession(session)
            ? "openpond-app-hybrid-chat-preflight"
            : "openpond-app-cloud-chat-preflight",
        });
        if (result.bootstrap) applyBootstrapPayload(result.bootstrap);
        const message = cloudWorkspaceReadyMessage(result.status, session);
        if (message) showToast(message, "success");
        return result.session;
      } finally {
        setWorkspaceBusy(false);
      }
    },
    [
      applyBootstrapPayload,
      connection,
      localProjectById,
      selectedCloudProject,
      selectedProject,
      setWorkspaceBusy,
      showToast,
      visibleWorkspaceState?.currentBranch,
    ],
  );
}
