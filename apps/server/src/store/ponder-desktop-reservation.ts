import {
  SessionSchema,
  PonderDesktopAttachmentSchema,
  PonderDesktopReservationResumeSchema,
  type PonderDesktopOperation,
  type PonderDesktopReservationResume,
} from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import {
  assertPonderDesktopOperationIdentity,
  ponderDesktopReservedSessionId,
} from "../openpond/ponder-desktop-operation-identity.js";
import {
  ponderDesktopSessionRevision,
  ponderDesktopExecutionRevision,
} from "../openpond/ponder-desktop-catalog.js";
import {
  ponderOwnsLocalSession,
  type PonderLocalOwner,
} from "../openpond/ponder-local-scope.js";

/** Read under the SQLite write lock; absence alone never authorizes an uncertain replay. */
export function readPonderDesktopReservationResume(
  db: OpenPondSqliteConnection,
  operation: PonderDesktopOperation,
  owner: PonderLocalOwner,
): PonderDesktopReservationResume | null {
  assertPonderDesktopOperationIdentity(operation);
  if (
    operation.intent.action !== "create" ||
    !operation.claimId ||
    operation.receipt ||
    !["dispatching", "attention"].includes(operation.state)
  )
    return null;
  const sessionId = ponderDesktopReservedSessionId(operation.id);
  const row = db.get<{ payload: string }>(
    "SELECT payload FROM sessions WHERE id = ?",
    [sessionId],
  );
  if (!row) return null;
  if (
    db.get("SELECT id FROM task_inputs WHERE session_id = ? LIMIT 1", [
      sessionId,
    ]) ||
    db.get("SELECT id FROM turns WHERE session_id = ? LIMIT 1", [sessionId])
  )
    return null;
  const session = SessionSchema.parse(JSON.parse(row.payload));
  const identity = session.metadata?.ponderDesktopReservation as
    | Record<string, unknown>
    | undefined;
  const authorityRow = db.get<{ payload: string }>(
    "SELECT payload FROM ponder_desktop_authority WHERE id = 1",
  );
  if (
    !authorityRow ||
    !identity ||
    !ponderOwnsLocalSession(session, owner) ||
    session.archived ||
    session.status !== "idle"
  )
    return null;
  const authority = PonderDesktopAttachmentSchema.parse(
    JSON.parse(authorityRow.payload),
  );
  if (
    authority.state !== "attached" ||
    Date.parse(authority.leaseExpiresAt) <= Date.now() ||
    authority.authorizationRevision !==
      operation.origin.authorizationRevision ||
    !Object.entries(operation.origin.scope).every(
      ([key, value]) =>
        authority.scope[key as keyof typeof authority.scope] === value,
    ) ||
    identity.operationId !== operation.id ||
    identity.payloadHash !== operation.payloadHash ||
    identity.sessionRevision !== ponderDesktopSessionRevision(session, null) ||
    identity.executionRevision !== ponderDesktopExecutionRevision(session)
  )
    return null;
  return PonderDesktopReservationResumeSchema.parse({
    sessionId,
    creationHash: identity.creationHash,
    sessionRevision: identity.sessionRevision,
    executionRevision: identity.executionRevision,
  });
}
