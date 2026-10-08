import { SessionSchema } from "@openpond/contracts";
import { ponderDesktopSessionRevision } from "../openpond/ponder-desktop-catalog.js";
import {
  ponderOwnsLocalSession,
  PonderLocalOwnerSchema,
  type PonderLocalOwner,
} from "../openpond/ponder-local-scope.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

export { localSessionMayResolveOwnership as ponderSessionMayAttach } from "../remote-relay/session-ownership.js";
import { localSessionMayResolveOwnership as ponderSessionMayAttach } from "../remote-relay/session-ownership.js";

/** Explicit local human selection. Account inference and cloud/model requests never call this. */
export function attachPonderSessionOwner(
  db: OpenPondSqliteConnection,
  input: {
    sessionId: string;
    expectedRevision: string;
    owner: PonderLocalOwner;
    assertCurrent?: () => void;
  },
) {
  input.assertCurrent?.();
  const owner = PonderLocalOwnerSchema.parse(input.owner);
  const row = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id = ?", [
    input.sessionId,
  ]);
  if (!row) throw new Error("ponder_desktop_attach_session_unavailable");
  const session = SessionSchema.parse(JSON.parse(row.payload));
  if (ponderOwnsLocalSession(session, owner)) return session;
  if (!ponderSessionMayAttach(session))
    throw new Error("ponder_desktop_attach_session_not_eligible");
  const latest = db.get<{ id: string }>(
    "SELECT id FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1",
    [session.id],
  );
  if (ponderDesktopSessionRevision(session, latest?.id ?? null) !== input.expectedRevision) {
    throw new Error("ponder_desktop_attach_session_changed");
  }
  const updated = {
    ...session,
    updatedAt: new Date().toISOString(),
    metadata: { ...session.metadata, ponderLocalOwner: owner },
  };
  db.run("UPDATE sessions SET payload = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(updated),
    updated.updatedAt,
    session.id,
  ]);
  return updated;
}
