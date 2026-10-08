import type { Session } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { deviceOwnsLocalSession, type DeviceLocalOwner } from "./local-scope.js";
import { localSessionMayResolveOwnership, localSessionOwnershipRevision } from "./session-ownership.js";

export type OwnerAttachmentQualifier = (session: Session) => Promise<{ eligible: boolean; reason: string | null }>;
export type PrepareOwnerAttachment = (owner: DeviceLocalOwner) => Promise<OwnerAttachmentQualifier>;

/** Candidate discovery is read-only and shares one captured readiness batch. */
export async function unresolvedLocalOwnership(input: {
  sessions: Session[];
  qualify: OwnerAttachmentQualifier;
  latestTurn: SqliteStore["latestTurnForSession"];
  assertCurrent(): void;
}) {
  const tasks: Array<{ id: string; title: string; revision: string }> = [];
  for (const session of input.sessions) {
    input.assertCurrent();
    if (!localSessionMayResolveOwnership(session) || !(await input.qualify(session)).eligible) continue;
    const latest = await input.latestTurn(session.id);
    tasks.push({ id: session.id, title: session.title,
      revision: localSessionOwnershipRevision(session, latest?.id ?? null) });
  }
  input.assertCurrent();
  return tasks;
}

/** Requalify the real stored task before the atomic revision-fenced human choice. */
export async function attachQualifiedLocalOwner(input: {
  store: Pick<SqliteStore, "getSession" | "attachLocalSessionOwner">;
  sessionId: string;
  expectedRevision: string;
  owner: DeviceLocalOwner;
  qualify: OwnerAttachmentQualifier;
  assertCurrent(): void;
}) {
  input.assertCurrent();
  const session = await input.store.getSession(input.sessionId);
  if (!session) throw new Error("remote_local_attachment_session_unavailable");
  if (!deviceOwnsLocalSession(session, input.owner)) {
    if (!localSessionMayResolveOwnership(session)) throw new Error("remote_local_attachment_not_eligible");
    const result = await input.qualify(session);
    if (!result.eligible) throw new Error(result.reason ?? "remote_local_attachment_not_eligible");
  }
  input.assertCurrent();
  return input.store.attachLocalSessionOwner({ sessionId: input.sessionId,
    expectedRevision: input.expectedRevision, owner: input.owner, assertCurrent: input.assertCurrent });
}
