import {
  PonderDesktopOperationSchema,
  SessionSchema,
  type PonderDesktopOperation,
} from "@openpond/contracts";
import { z } from "zod";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { assertPonderDesktopRecipient } from "./ponder-desktop-input.js";
import { readInboxOwner } from "./task-inbox-records.js";
import { assertPonderDesktopOperationIdentity } from "../openpond/ponder-desktop-operation-identity.js";

export const PonderDesktopStopSchema = z
  .object({
    operation: PonderDesktopOperationSchema,
    receipt: PonderDesktopOperationSchema.shape.receipt.unwrap(),
  })
  .strict();

export function readPonderDesktopStop(db: OpenPondSqliteConnection, id: string) {
  const row = db.get<{ payload: string }>(
    "SELECT payload FROM ponder_desktop_stops WHERE operation_id = ?",
    [id],
  );
  return row ? PonderDesktopStopSchema.parse(JSON.parse(row.payload)) : null;
}

export function admitPonderDesktopStop(
  db: OpenPondSqliteConnection,
  operation: PonderDesktopOperation,
) {
  operation = PonderDesktopOperationSchema.parse(operation);
  assertPonderDesktopOperationIdentity(operation);
  if (operation.intent.action !== "stop") throw new Error("ponder_desktop_stop_intent_invalid");
  const previous = readPonderDesktopStop(db, operation.id);
  if (previous) {
    if (previous.operation.payloadHash !== operation.payloadHash)
      throw new Error("ponder_desktop_stop_identity_reused");
    return previous;
  }
  const sessionRow = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id = ?", [
    operation.intent.targetId,
  ]);
  if (!sessionRow) throw new Error("ponder_desktop_stop_target_unavailable");
  const session = SessionSchema.parse(JSON.parse(sessionRow.payload));
  const latest = db.get<{ id: string }>(
    "SELECT id FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1",
    [session.id],
  );
  assertPonderDesktopRecipient(
    db,
    operation,
    session,
    latest?.id ?? null,
    operation.intent.targetRevision,
  );
  const inbox = readInboxOwner(db, session.id);
  const turn = db.get<{ status: string }>(
    "SELECT status FROM turns WHERE id = ? AND session_id = ?",
    [operation.intent.expectedTurnId, session.id],
  );
  if (
    !inbox ||
    inbox.turn_id !== operation.intent.expectedTurnId ||
    inbox.lease_until <= Date.now() ||
    turn?.status !== "in_progress"
  )
    throw new Error("ponder_desktop_stop_target_changed");
  const admitted = PonderDesktopStopSchema.parse({
    operation,
    receipt: {
      sessionId: session.id,
      sessionTitle: session.title,
      inputId: null,
      turnId: operation.intent.expectedTurnId,
      state: "stop_requested",
    },
  });
  db.run(
    "INSERT INTO ponder_desktop_stops (operation_id, payload_hash, payload) VALUES (?, ?, ?)",
    [operation.id, operation.payloadHash, JSON.stringify(admitted)],
  );
  return admitted;
}

export function settlePonderDesktopStop(
  db: OpenPondSqliteConnection,
  id: string,
  state: "interrupted" | "already_finished",
) {
  const stop = readPonderDesktopStop(db, id);
  if (!stop) throw new Error("ponder_desktop_stop_not_found");
  if (stop.receipt.state !== "stop_requested") return stop;
  const settled = { ...stop, receipt: { ...stop.receipt, state } };
  db.run("UPDATE ponder_desktop_stops SET payload = ? WHERE operation_id = ?", [
    JSON.stringify(settled),
    id,
  ]);
  return settled;
}
