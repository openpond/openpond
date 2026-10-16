import { SessionSchema, type Session } from "@openpond/contracts";
import { LocalPonderCoordinatorSchema } from "../openpond/local-ponder-contract.js";
import { DeviceLocalOwnerSchema, deviceOwnsLocalSession, type DeviceLocalOwner } from "../remote-relay/local-scope.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

export function readRemotePonder(db: OpenPondSqliteConnection) {
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='local_ponder_state'")) return null;
  const row = db.get<{ payload: string }>("SELECT payload FROM local_ponder_state WHERE id=1");
  return row ? LocalPonderCoordinatorSchema.parse(JSON.parse(row.payload)) : null;
}

/** Revocation fences admission as well as catalog/history visibility. */
export function assertLocalPonderRemoteAccess(db: OpenPondSqliteConnection, session: Session) {
  if (session.systemKind !== "openpond.ponder") return;
  const state = readRemotePonder(db);
  if (!state?.remoteAccessEnabled || state.sessionId !== session.id
    || session.metadata?.localPonderCoordinatorId !== state.id) throw new Error("remote_ponder_access_off");
}

/** Local human consent only. Caller executes under BEGIN IMMEDIATE and an account-generation guard. */
export function changeLocalPonderRemoteAccess(db: OpenPondSqliteConnection, input: {
  enabled: boolean; revision: number; owner: DeviceLocalOwner; assertCurrent(): void;
}) {
  input.assertCurrent();
  const owner = DeviceLocalOwnerSchema.parse(input.owner);
  const state = readRemotePonder(db);
  if (!state?.sessionId) throw new Error("remote_ponder_unavailable");
  if (state.revision !== input.revision) throw new Error("remote_ponder_configuration_changed");
  const row = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id=?", [state.sessionId]);
  const session = row ? SessionSchema.parse(JSON.parse(row.payload)) : null;
  if (!session || session.systemKind !== "openpond.ponder" || session.metadata?.localPonderCoordinatorId !== state.id
    || session.archived || session.status === "closed") throw new Error("remote_ponder_unavailable");
  // Existing ownership is never reassigned on account change, including an explicit publish retry.
  if (session.metadata?.ponderLocalOwner !== undefined && !deviceOwnsLocalSession(session, owner))
    throw new Error("remote_ponder_owner_changed");
  const updated = { ...session, metadata: { ...session.metadata, ponderLocalOwner: owner }, updatedAt: new Date().toISOString() };
  const coordinator = { ...state, remoteAccessEnabled: input.enabled,
    revision: state.revision + (state.remoteAccessEnabled === input.enabled ? 0 : 1) };
  db.run("UPDATE sessions SET payload=?,updated_at=? WHERE id=?", [JSON.stringify(updated), updated.updatedAt, session.id]);
  db.run("UPDATE local_ponder_state SET payload=? WHERE id=1", [JSON.stringify(coordinator)]);
  return { coordinator, session: updated };
}
