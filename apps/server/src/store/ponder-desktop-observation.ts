import { z } from "zod";
import {
  PonderDesktopOperationSchema,
  SessionSchema,
  type PonderDesktopOperation,
} from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { assertPonderDesktopRecipient } from "./ponder-desktop-input.js";
import { assertPonderDesktopOperationIdentity } from "../openpond/ponder-desktop-operation-identity.js";

const ObservationSchema = z
  .object({
    operation: PonderDesktopOperationSchema,
    receipt: PonderDesktopOperationSchema.shape.receipt.unwrap(),
  })
  .strict();

export function readPonderDesktopObservation(db: OpenPondSqliteConnection, id: string) {
  const row = db.get<{ payload: string; payload_hash: string }>(
    "SELECT payload, payload_hash FROM ponder_desktop_observations WHERE operation_id = ?",
    [id],
  );
  if (!row) return null;
  const observation = ObservationSchema.parse(JSON.parse(row.payload));
  assertPonderDesktopOperationIdentity(observation.operation);
  if (
    observation.operation.id !== id ||
    observation.operation.payloadHash !== row.payload_hash ||
    observation.operation.intent.action !== "observe" ||
    observation.receipt.turnId !== observation.operation.intent.expectedTurnId ||
    observation.receipt.sessionId !== observation.operation.intent.targetId ||
    observation.receipt.inputId !== null
  ) {
    throw new Error("ponder_desktop_observation_record_invalid");
  }
  return observation;
}

/** Watching an exact turn persists authority without inserting input or starting provider work. */
export function admitPonderDesktopObservation(
  db: OpenPondSqliteConnection,
  value: PonderDesktopOperation,
) {
  const operation = PonderDesktopOperationSchema.parse(value);
  assertPonderDesktopOperationIdentity(operation);
  if (operation.intent.action !== "observe")
    throw new Error("ponder_desktop_observation_intent_invalid");
  const previous = readPonderDesktopObservation(db, operation.id);
  if (previous) {
    if (previous.operation.payloadHash !== operation.payloadHash)
      throw new Error("ponder_desktop_observation_identity_reused");
    return previous;
  }
  const row = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id = ?", [
    operation.intent.targetId,
  ]);
  if (!row) throw new Error("ponder_desktop_observation_target_unavailable");
  const session = SessionSchema.parse(JSON.parse(row.payload));
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
  const turn = db.get<{ id: string }>("SELECT id FROM turns WHERE id = ? AND session_id = ?", [
    operation.intent.expectedTurnId,
    session.id,
  ]);
  if (!turn || latest?.id !== turn.id) throw new Error("ponder_desktop_observation_target_changed");
  const observation = ObservationSchema.parse({
    operation,
    receipt: {
      sessionId: session.id,
      sessionTitle: session.title,
      inputId: null,
      turnId: turn.id,
      state: "observing",
    },
  });
  db.run(
    "INSERT INTO ponder_desktop_observations (operation_id, payload_hash, payload) VALUES (?, ?, ?)",
    [operation.id, operation.payloadHash, JSON.stringify(observation)],
  );
  return observation;
}
