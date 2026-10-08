import { createHash } from "node:crypto";
import { ponderDesktopRequestContent, type Session } from "@openpond/contracts";
import { localManagedTargetRevision } from "../runtime/task-inbox/target-revision.js";
import { isCodexHistorySessionId } from "../codex-history.js";

export function localSessionOwnershipRevision(session: Session, latestTurnId: string | null) {
  return createHash("sha256").update(ponderDesktopRequestContent("POST", "/ponder/desktop/catalog", {
    managedRevision: localManagedTargetRevision(session, latestTurnId),
    modelRef: session.modelRef ?? null,
    profile: session.currentProfile ?? null,
    profileWorkflowBinding: session.profileWorkflowBinding ?? null,
    profileComponentBinding: session.profileComponentBinding ?? null,
    experience: session.experience,
    owner: session.metadata?.ponderLocalOwner ?? null,
    projectRevision: session.metadata?.ponderWorkspaceRevision ?? null,
    commandAccessMode: session.openPondCommandAccessMode,
  })).digest("hex");
}


export function localSessionMayResolveOwnership(session: Session) {
  return session.metadata?.ponderLocalOwner === undefined && !session.archived && !session.systemKind
    && !session.hiddenFromDefaultSidebar && session.status !== "closed" && session.experience !== "development"
    && !session.metadata?.nativeHistoryProjection && !isCodexHistorySessionId(session.id)
    && !["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "");
}

export function remoteExecutionRevision(session: Session) {
  return createHash("sha256").update(JSON.stringify({ provider: session.provider, modelRef: session.modelRef,
    profile: session.currentProfile, workflow: session.profileWorkflowBinding, component: session.profileComponentBinding,
    cwd: session.cwd, workspaceKind: session.workspaceKind, workspaceId: session.workspaceId, localProjectId: session.localProjectId,
    owner: session.metadata?.ponderLocalOwner, commandAccessMode: session.openPondCommandAccessMode })).digest("hex");
}
export function remoteExecutionSnapshot(session: Session) {
  return { revision: remoteExecutionRevision(session), managedSessionId: session.provider === "codex" ? session.codexThreadId : session.nativeAgent?.sessionId ?? null };
}
export function assertRemoteExecution(input: Pick<import("@openpond/contracts").TaskInputAdmission, "payload">, session: Session) {
  if (!input.payload.remoteDevice) return;
  const snapshot = input.payload.remoteDeviceExecution as ReturnType<typeof remoteExecutionSnapshot> | undefined;
  const current = remoteExecutionSnapshot(session);
  if (!snapshot || snapshot.revision !== current.revision || snapshot.managedSessionId && snapshot.managedSessionId !== current.managedSessionId)
    throw new Error("The local task's provider, Profile, workspace or original agent changed before the remote instruction could run.");
}
