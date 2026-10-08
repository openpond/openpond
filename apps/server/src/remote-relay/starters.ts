import { createHash } from "node:crypto";
import { remoteDeviceCanonicalContent, type RemoteStarter, type Session } from "@openpond/contracts";
import { deviceOwnsLocalSession, type DeviceLocalOwner } from "./local-scope.js";

export function remoteStarterPayload(session: Session) {
  return { provider: session.provider, cwd: session.cwd, localProjectId: session.localProjectId,
    workspaceId: session.workspaceId, workspaceKind: session.workspaceKind, workspaceName: session.workspaceName,
    modelRef: session.modelRef, currentProfile: session.currentProfile, experience: session.experience,
    profileWorkflowBinding: session.profileWorkflowBinding, profileComponentBinding: session.profileComponentBinding,
    openPondCommandAccessMode: session.openPondCommandAccessMode };
}
export function remoteStarterRevision(session: Session) {
  return Number.parseInt(createHash("sha256").update(remoteDeviceCanonicalContent({ payload: remoteStarterPayload(session),
    owner: session.metadata?.ponderLocalOwner })).digest("hex").slice(0, 13), 16);
}

/** A starter inherits an already-owned local task's project/configuration, never cloud supplied paths. */
export function captureRemoteStarters(sessions: Session[], owner: DeviceLocalOwner) {
  const starters = new Map<string, { target: RemoteStarter; source: Session }>();
  for (const session of sessions) {
    if (!deviceOwnsLocalSession(session, owner) || !session.localProjectId || !session.cwd || session.archived
      || session.systemKind || session.hiddenFromDefaultSidebar || session.metadata?.nativeHistoryProjection
      || !["codex", "claude-code", "opencode", "grok-build"].includes(session.provider)
      || ["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "")) continue;
    const id = `starter:${session.id}`;
    starters.set(id, { source: session, target: { id, projectId: session.localProjectId,
      projectLabel: session.workspaceName ?? "Local project", title: `New ${session.provider} task in ${session.workspaceName ?? "local project"}`,
      revision: remoteStarterRevision(session) } });
  }
  return starters;
}
