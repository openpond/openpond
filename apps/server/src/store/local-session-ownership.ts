import { SessionSchema } from "@openpond/contracts";
import { localSessionMayResolveOwnership, localSessionOwnershipRevision } from "../remote-relay/session-ownership.js";
import {
  deviceOwnsLocalSession,
  DeviceLocalOwnerSchema,
  type DeviceLocalOwner,
} from "../remote-relay/local-scope.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

/** Explicit local human selection. Account inference and cloud/model requests never call this. */
export function attachLocalSessionOwner(
  db: OpenPondSqliteConnection,
  input: {
    sessionId: string;
    expectedRevision: string;
    owner: DeviceLocalOwner;
    assertCurrent?: () => void;
  },
) {
  input.assertCurrent?.();
  const owner = DeviceLocalOwnerSchema.parse(input.owner);
  const row = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id = ?", [
    input.sessionId,
  ]);
  if (!row) throw new Error("ponder_desktop_attach_session_unavailable");
  const session = SessionSchema.parse(JSON.parse(row.payload));
  if (deviceOwnsLocalSession(session, owner)) return session;
  if (!localSessionMayResolveOwnership(session))
    throw new Error("ponder_desktop_attach_session_not_eligible");
  const latest = db.get<{ id: string }>(
    "SELECT id FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1",
    [session.id],
  );
  if (localSessionOwnershipRevision(session, latest?.id ?? null) !== input.expectedRevision) {
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
