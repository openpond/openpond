import { useMemo } from "react";
import type {
  BootstrapPayload,
  CloudProject,
  LocalProject,
  OpenPondApp,
  Session,
} from "@openpond/contracts";
import {
  latestPendingApprovalForSession,
  type RuntimeIndexes,
} from "../lib/runtime-indexes";

export function useAppConversationContext({
  bootstrap,
  mentionableSandboxApps,
  runtimeIndexes,
  selectedApp,
  selectedCloudProject,
  selectedProject,
  selectedSession,
  selectedSessionId,
}: {
  bootstrap: BootstrapPayload | null;
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
    for (const project of bootstrap?.cloudProjects ?? []) {
      const existing = groups.get(project.teamId) ?? [];
      existing.push(project.id);
      groups.set(project.teamId, existing);
    }
    return groups;
  }, [bootstrap?.cloudProjects]);
  const chatMentionApps =
    selectedSession || selectedApp || selectedProject || selectedCloudProject ? [] : mentionableSandboxApps;
  const pendingApproval = useMemo(() => {
    return latestPendingApprovalForSession(runtimeIndexes, selectedSessionId);
  }, [runtimeIndexes, selectedSessionId]);

  return {
    chatMentionApps,
    cloudProjectIdsByTeam,
    pendingApproval,
  };
}
