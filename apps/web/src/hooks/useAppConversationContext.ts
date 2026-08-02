import { useMemo } from "react";
import type {
  CloudProject,
  ConnectedAppStatusRow,
  LocalProject,
  OpenPondApp,
  Session,
} from "@openpond/contracts";
import {
  connectedAppMentionOptionsFromStatusRows,
} from "../lib/connected-app-mentions";
import {
  latestPendingApprovalForSession,
  type RuntimeIndexes,
} from "../lib/runtime-indexes";

export function useAppConversationContext({
  cloudProjects,
  connectedAppRows,
  mentionableSandboxApps,
  runtimeIndexes,
  selectedApp,
  selectedCloudProject,
  selectedProject,
  selectedSession,
  selectedSessionId,
}: {
  cloudProjects: CloudProject[];
  connectedAppRows: ConnectedAppStatusRow[];
  mentionableSandboxApps: OpenPondApp[];
  runtimeIndexes: RuntimeIndexes;
  selectedApp: OpenPondApp | null;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedSession: Session | null;
  selectedSessionId: string | null;
}) {
  const cloudProjectIdsByTeam = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const project of cloudProjects) {
      const existing = groups.get(project.teamId) ?? [];
      existing.push(project.id);
      groups.set(project.teamId, existing);
    }
    return groups;
  }, [cloudProjects]);
  const hasScopedConversationContext = Boolean(selectedSession || selectedApp || selectedProject || selectedCloudProject);
  const chatMentionApps = hasScopedConversationContext ? [] : mentionableSandboxApps;
  const connectedAppMentions = useMemo(
    () => connectedAppMentionOptionsFromStatusRows(connectedAppRows),
    [connectedAppRows],
  );
  const pendingApproval = useMemo(() => {
    return latestPendingApprovalForSession(runtimeIndexes, selectedSessionId);
  }, [runtimeIndexes, selectedSessionId]);

  return {
    chatMentionApps,
    cloudProjectIdsByTeam,
    connectedAppMentions,
    pendingApproval,
  };
}
