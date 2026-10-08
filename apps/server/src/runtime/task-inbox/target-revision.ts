import { createHash } from "node:crypto";
import type { Session } from "@openpond/contracts";
import { localManagedSessionId } from "./local-managed-identity.js";

export function localManagedTargetRevision(session: Session, latestTurnId: string | null): string {
  return createHash("sha256").update(JSON.stringify({
    id: session.id, provider: session.provider,
    managedSessionId: localManagedSessionId(session),
    nativeAgent: session.nativeAgent ?? null, cwd: session.cwd,
    nativeHistoryProjection: session.metadata?.nativeHistoryProjection === true,
    nativeResumeAvailable: session.metadata?.nativeResumeAvailable === true,
    nativeBranch: session.metadata?.nativeBranch ?? null,
    workspaceKind: session.workspaceKind ?? null, workspaceId: session.workspaceId ?? null,
    localProjectId: session.localProjectId ?? null, latestTurnId,
  })).digest("hex");
}
