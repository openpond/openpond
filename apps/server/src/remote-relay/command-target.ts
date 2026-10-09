import { createHash } from "node:crypto";
import type { Session } from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "../store/sqlite/sqlite-driver.js";
import { localSessionOwnershipRevision } from "./session-ownership.js";

export type RemoteCommandTargetState = { paused: boolean; activeTurnId: string | null };

/** Remote controls fence lifecycle state without changing persisted ownership identity. */
export function remoteCommandTargetRevision(session: Session, latestTurnId: string | null, state: RemoteCommandTargetState) {
  const revision = createHash("sha256").update(JSON.stringify({
    ownership: localSessionOwnershipRevision(session, latestTurnId), paused: state.paused, activeTurnId: state.activeTurnId,
  })).digest("hex");
  return Number.parseInt(revision.slice(0, 13), 16);
}

/** Same lease/status interpretation used by the canonical inbox snapshot. */
export function readRemoteCommandTargetState(db: OpenPondSqliteConnection, sessionId: string): RemoteCommandTargetState {
  const owner = db.get<{ turn_id: string; paused: number; lease_until: number }>(
    "SELECT turn_id,paused,lease_until FROM task_inbox_turns WHERE session_id=?", [sessionId]);
  const active = owner && owner.lease_until > Date.now()
    && db.get<{ status: string }>("SELECT status FROM turns WHERE id=?", [owner.turn_id])?.status === "in_progress";
  return { paused: Boolean(owner?.paused), activeTurnId: active ? owner.turn_id : null };
}

/** A fresh explicit resume admits queued work; replay never reaches this mutation. */
export function resumeRemoteTaskInput(db: OpenPondSqliteConnection, command: import("@openpond/contracts").RemoteDispatchCommand) {
  if (command.payload.resume !== true) return;
  if (command.action !== "follow_up") throw new Error("remote_resume_action_invalid");
  const owner = db.get<{ turn_id: string; paused: number; lease_until: number }>(
    "SELECT turn_id,paused,lease_until FROM task_inbox_turns WHERE session_id=?", [command.localSessionId]);
  const latest = db.get<{ id: string; status: string }>(
    "SELECT id,status FROM turns WHERE session_id=? ORDER BY sort_index DESC LIMIT 1", [command.localSessionId]);
  if (!command.expectedTurnId || latest?.id !== command.expectedTurnId || owner?.turn_id !== command.expectedTurnId
    || !owner.paused || owner.lease_until > Date.now() || !["completed", "failed", "interrupted"].includes(latest.status))
    throw new Error("remote_resume_target_changed");
  db.run("UPDATE task_inbox_turns SET paused=0 WHERE session_id=?", [command.localSessionId]);
}
