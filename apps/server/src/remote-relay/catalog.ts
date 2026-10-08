import { createHash, randomUUID } from "node:crypto";
import type { LocalManagedMessageTarget, RemoteTask, Session } from "@openpond/contracts";
import { localSessionOwnershipRevision } from "./session-ownership.js";
import { remoteApprovalSupported } from "./approvals.js";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "../store/store-schema.js";
import { deviceOwnsLocalSession, type DeviceLocalOwner } from "./local-scope.js";

let historyIncarnation = randomUUID();
let observedHistorySequence = 0;

/** Restart and observed durable rollback require a fresh authoritative snapshot. */
export function remoteHistoryIncarnation() { return historyIncarnation; }

export function observeRemoteHistorySequence(sequence: number) {
  const changed = sequence < observedHistorySequence;
  if (changed) historyIncarnation = randomUUID();
  observedHistorySequence = sequence;
  return changed;
}

export function remoteTaskRevision(target: LocalManagedMessageTarget, session: Session) {
  return Number.parseInt(localSessionOwnershipRevision(session, target.latestTurnId).slice(0, 13), 16);
}
export function remoteHistoryGeneration(session: Session) {
  return createHash("sha256").update(JSON.stringify([historyIncarnation, session.id, session.createdAt, CURRENT_SQLITE_SCHEMA_VERSION])).digest("hex");
}

/** Protected ownership is mandatory even for read-only historical publication. */
export async function captureRemoteTaskCatalog(input: {
  owner: DeviceLocalOwner;
  sessions: Session[];
  inspect(id: string): Promise<LocalManagedMessageTarget>;
  approvals?: import("@openpond/contracts").Approval[];
  latestTurn?(id: string): Promise<import("@openpond/contracts").Turn | null>;
}): Promise<RemoteTask[]> {
  const tasks: RemoteTask[] = [];
  for (const session of input.sessions) {
    if (!deviceOwnsLocalSession(session, input.owner) || session.systemKind || session.hiddenFromDefaultSidebar
      || ["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "")) continue;
    const target = await input.inspect(session.id);
    const latest = await input.latestTurn?.(session.id);
    const approval = input.approvals?.find(approval => approval.sessionId === session.id && approval.status === "pending"
      && remoteApprovalSupported(approval));
    tasks.push({ id: session.id, localSessionId: session.id, title: session.title,
      projectId: session.localProjectId ?? null, projectLabel: session.workspaceName ?? null,
      provider: session.provider, revision: remoteTaskRevision(target, session), historyGeneration: remoteHistoryGeneration(session),
      createdAt: session.createdAt, updatedAt: session.updatedAt,
      lastEventSequence: 0, activeTurnId: target.activeTurnId, approvalId: approval?.id ?? null,
      archived: session.archived ?? false, deleted: false,
      state: target.approvalBlocked ? "attention" : target.activeTurnId ? "running" : latest?.status === "failed" ? "failed" : latest?.status === "completed" ? "completed" : "idle",
      capabilities: { followUp: target.canSendFollowup, steer: target.canSteer,
        stop: target.activeTurnId !== null && target.managedSessionId !== null, approval: !!approval, artifacts: false },
    });
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
