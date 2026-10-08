import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PonderDesktopInspectionSchema,
  PonderDesktopOperationSchema,
  SessionSchema,
  TurnSchema,
  ponderDesktopRequestContent,
  type PonderDesktopOperation,
} from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { assertPonderDesktopRecipient } from "./ponder-desktop-input.js";
import { assertPonderDesktopOperationIdentity } from "../openpond/ponder-desktop-operation-identity.js";

const RecordSchema = z.object({
  operation: PonderDesktopOperationSchema,
  receipt: PonderDesktopOperationSchema.shape.receipt.unwrap(),
  inspection: PonderDesktopInspectionSchema,
}).strict();
function snapshotHash(value: z.infer<typeof RecordSchema>) {
  return createHash("sha256")
    .update(ponderDesktopRequestContent("POST", "/ponder/desktop/inspection", value))
    .digest("hex");
}

export function readPonderDesktopInspection(db: OpenPondSqliteConnection, id: string) {
  const row = db.get<{ payload: string; payload_hash: string; snapshot_hash: string }>(
    "SELECT payload, payload_hash, snapshot_hash FROM ponder_desktop_inspections WHERE operation_id = ?",
    [id],
  );
  if (!row) return null;
  const record = RecordSchema.parse(JSON.parse(row.payload));
  assertPonderDesktopOperationIdentity(record.operation);
  const { operation, receipt, inspection } = record;
  if (operation.intent.action !== "inspect" || operation.id !== id ||
      operation.payloadHash !== row.payload_hash || snapshotHash(record) !== row.snapshot_hash ||
      inspection.operationId !== id || inspection.payloadHash !== operation.payloadHash ||
      inspection.sessionId !== operation.intent.targetId ||
      inspection.turnId !== operation.intent.expectedTurnId ||
      receipt.sessionId !== inspection.sessionId || receipt.turnId !== inspection.turnId ||
      receipt.inputId !== null || receipt.state !== "inspected")
    throw new Error("ponder_desktop_inspection_record_invalid");
  return record;
}

type EventRow = {
  sequence: number; id: string; timestamp: string;
  kind: "assistant.delta" | "tool.started" | "tool.completed";
  text: string | null; action: string | null;
  status: "started" | "completed" | "failed" | "pending" | null;
  message_id: string | null; message_snapshot: number | null;
};

/** One SQLite transaction fences the target and captures immutable bounded evidence. */
export function admitPonderDesktopInspection(db: OpenPondSqliteConnection, value: PonderDesktopOperation) {
  const operation = PonderDesktopOperationSchema.parse(value);
  assertPonderDesktopOperationIdentity(operation);
  if (operation.intent.action !== "inspect") throw new Error("ponder_desktop_inspection_intent_invalid");
  const previous = readPonderDesktopInspection(db, operation.id);
  if (previous) {
    if (previous.operation.payloadHash !== operation.payloadHash)
      throw new Error("ponder_desktop_inspection_identity_reused");
    return previous;
  }
  const sessionRow = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id = ?", [operation.intent.targetId]);
  if (!sessionRow) throw new Error("ponder_desktop_inspection_target_unavailable");
  const session = SessionSchema.parse(JSON.parse(sessionRow.payload));
  const workspaceId = session.localProjectId ?? session.workspaceId ?? session.cwd;
  if (session.archived || session.systemKind || session.hiddenFromDefaultSidebar ||
      session.status === "closed" || session.experience === "development" ||
      ["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "") ||
      operation.target.kind !== "session" || operation.target.id !== session.id ||
      operation.target.revision !== operation.intent.targetRevision ||
      operation.target.workspaceId !== workspaceId || operation.target.providerId !== session.provider ||
      operation.target.modelId !== (session.modelRef?.modelId ?? null))
    throw new Error("ponder_desktop_inspection_target_changed");
  const latest = db.get<{ id: string; payload: string }>(
    "SELECT id, payload FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1", [session.id],
  );
  assertPonderDesktopRecipient(db, operation, session, latest?.id ?? null, operation.intent.targetRevision);
  if (!latest || latest.id !== operation.intent.expectedTurnId)
    throw new Error("ponder_desktop_inspection_target_changed");
  const turn = TurnSchema.parse(JSON.parse(latest.payload));
  if (turn.sessionId !== session.id || turn.id !== latest.id)
    throw new Error("ponder_desktop_inspection_turn_invalid");

  // Project bounded fields in SQL: even an oversized provider payload never gets loaded whole.
  // Extra row establishes omitted older evidence, while reasoning/history stays out of the read.
  const rows = db.all<EventRow>(`
    SELECT sequence, substr(json_extract(payload, '$.id'), 1, 201) AS id,
      substr(json_extract(payload, '$.timestamp'), 1, 101) AS timestamp, name AS kind,
      substr(json_extract(payload, '$.output'), 1, 4001) AS text,
      substr(json_extract(payload, '$.action'), 1, 300) AS action,
      json_extract(payload, '$.status') AS status,
      substr(coalesce(json_extract(payload, '$.data.nativeMessageId'), json_extract(payload, '$.data.itemId')), 1, 300) AS message_id,
      json_extract(payload, '$.data.nativeMessageSnapshot') AS message_snapshot
    FROM events WHERE turn_id = ? AND session_id = ?
      AND name IN ('assistant.delta', 'tool.started', 'tool.completed')
      AND coalesce(json_extract(payload, '$.data.retainedHistory'), 0) <> 1
      AND coalesce(json_extract(payload, '$.data.phase'), '') NOT IN ('reasoning', 'analysis')
    ORDER BY sequence DESC LIMIT 101`, [turn.id, session.id]);
  let budget = 16_000;
  let textTruncated = false;
  const events = rows.slice(0, 100).map(row => {
    const fullText = row.text ?? "";
    const size = Math.min(4_000, budget);
    // Keep the newest text when the shared budget is exhausted; preserve event identities.
    const text = fullText.slice(0, size);
    budget -= text.length;
    textTruncated ||= fullText.length > size;
    return {
      id: row.id, sequence: row.sequence, timestamp: row.timestamp, kind: row.kind,
      text, action: row.action, status: row.status,
      messageId: row.message_id, messageSnapshot: row.message_snapshot === 1,
    };
  }).reverse();
  const inspection = PonderDesktopInspectionSchema.parse({
    operationId: operation.id, payloadHash: operation.payloadHash,
    sessionId: session.id, sessionTitle: session.title.slice(0, 300), turnId: turn.id,
    workspaceId,
    providerId: turn.modelRef?.providerId ?? operation.target.providerId,
    modelId: turn.modelRef?.modelId ?? operation.target.modelId,
    capturedAt: new Date().toISOString(), taskStatus: turn.status,
    taskCompletedAt: turn.completedAt ? new Date(turn.completedAt).toISOString() : null,
    error: turn.error?.slice(0, 2_000) ?? null, events,
    coverage: { olderEventsOmitted: rows.length > 100, textTruncated, textLimit: 16_000, eventLimit: 100 },
  });
  const record = RecordSchema.parse({
    operation, inspection,
    receipt: { sessionId: session.id, sessionTitle: inspection.sessionTitle, inputId: null, turnId: turn.id, state: "inspected" },
  });
  // Recheck before persisting; BEGIN IMMEDIATE also excludes another store's revocation/turn change.
  assertPonderDesktopRecipient(db, operation, session, latest.id, operation.intent.targetRevision);
  db.run("INSERT INTO ponder_desktop_inspections (operation_id, payload_hash, snapshot_hash, payload) VALUES (?, ?, ?, ?)",
    [operation.id, operation.payloadHash, snapshotHash(record), JSON.stringify(record)]);
  return record;
}
