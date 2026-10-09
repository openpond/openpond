import { isDeepStrictEqual } from "node:util";
import { TaskInputSchema, TASK_INBOX_MAX_PENDING, type TaskInput, type TaskInputAdmission } from "@openpond/contracts/task-inbox";
import { type Session, type Turn } from "@openpond/contracts/sessions";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { localManagedTargetRevision } from "../runtime/task-inbox/target-revision.js";
import { LocalManagedMessageError } from "../runtime/task-inbox/local-managed-message-error.js";
import { assertPonderDesktopInput } from "./ponder-desktop-input.js";
import { assertRemoteAdmission } from "../remote-relay/admission.js";
import type { RemoteDispatchCommand } from "@openpond/contracts";
import { resumeRemoteTaskInput } from "../remote-relay/command-target.js";
import { remoteExecutionSnapshot } from "../remote-relay/session-ownership.js";

export type TaskInboxOwner = {
  session_id: string; turn_id: string; owner_id: string; generation: number;
  accepting: number; paused: number; lease_until: number;
};
type InputRow = { sequence: number; payload: string };

export function inputFromRow(row: InputRow): TaskInput {
  return TaskInputSchema.parse({ ...JSON.parse(row.payload), sequence: row.sequence });
}

export function readTaskInput(db: OpenPondSqliteConnection, id: string): TaskInput | null {
  const row = db.get<InputRow>("SELECT sequence, payload FROM task_inputs WHERE id = ?", [id]);
  return row ? inputFromRow(row) : null;
}

export function writeTaskInput(db: OpenPondSqliteConnection, value: TaskInput): TaskInput {
  const input = TaskInputSchema.parse(value);
  db.run("UPDATE task_inputs SET kind = ?, state = ?, turn_id = ?, payload = ? WHERE id = ?", [
    input.kind, input.state, input.turnId, JSON.stringify(input), input.id,
  ]);
  return input;
}

export function readInboxOwner(db: OpenPondSqliteConnection, sessionId: string): TaskInboxOwner | null {
  return db.get<TaskInboxOwner>("SELECT * FROM task_inbox_turns WHERE session_id = ?", [sessionId]);
}

export function requireInboxOwner(db: OpenPondSqliteConnection, sessionId: string, turnId: string, ownerId: string): TaskInboxOwner {
  const owner = readInboxOwner(db, sessionId);
  if (!owner || owner.turn_id !== turnId || owner.owner_id !== ownerId || owner.lease_until <= Date.now()) {
    throw new Error("Task execution ownership was lost. Stop before dispatching more work.");
  }
  return owner;
}

export function assertSteerTarget(db: OpenPondSqliteConnection, sessionId: string, turnId: string | null): void {
  const owner = readInboxOwner(db, sessionId);
  const row = turnId ? db.get<{ status: Turn["status"] }>("SELECT status FROM turns WHERE id = ? AND session_id = ?", [turnId, sessionId]) : null;
  if (!turnId || !owner || owner.turn_id !== turnId || !owner.accepting || owner.paused ||
      owner.lease_until <= Date.now() || row?.status !== "in_progress") {
    throw new Error("The expected turn is no longer accepting input. Your text was not sent to a different turn; send it as a follow-up instead.");
  }
}

export function admitTaskInput(db: OpenPondSqliteConnection, admission: TaskInputAdmission): TaskInput {
  const senderKey = `${admission.senderKind}:${admission.senderSessionId ?? "user"}`;
  const previous = db.get<InputRow & { admission: string }>(
    "SELECT sequence, payload, admission FROM task_inputs WHERE session_id = ? AND sender_key = ? AND idempotency_key = ?",
    [admission.sessionId, senderKey, admission.idempotencyKey],
  );
  if (previous) {
    const existing = inputFromRow(previous);
    const original = JSON.parse(previous.admission) as TaskInputAdmission;
    const fields = ["kind", "body", "payload", "replyTo", "expectedTurnId"] as const;
    if (fields.some((field) => !isDeepStrictEqual(original[field], admission[field]))) {
      throw new Error("This input identity was already used with different content.");
    }
    return existing;
  }
  const sessionRow = db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id = ?", [admission.sessionId]);
  const session: Session | null = sessionRow ? JSON.parse(sessionRow.payload) : null;
  if (!session || session.status === "closed" || session.archived) throw new Error("The recipient task is unavailable.");
  if (admission.payload.remoteDevice !== undefined) {
    if (admission.senderKind !== "user" || admission.senderSessionId !== null) throw new Error("remote_human_input_required");
    assertRemoteAdmission(db, admission.payload.remoteDevice as RemoteDispatchCommand, session);
  }
  if (admission.senderKind === "ponder" || admission.payload.ponderDesktop !== undefined) {
    const latest = db.get<{ id: string }>("SELECT id FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1", [admission.sessionId]);
    assertPonderDesktopInput(db, admission, session, latest?.id ?? null);
  }
  const localMessage = admission.payload.localManagedMessage;
  if (localMessage && typeof localMessage === "object") {
    const expected = (localMessage as Record<string, unknown>).targetRevision;
    const latest = db.get<{ id: string }>("SELECT id FROM turns WHERE session_id = ? ORDER BY sort_index DESC LIMIT 1", [admission.sessionId]);
    if (typeof expected !== "string" || expected !== localManagedTargetRevision(session, latest?.id ?? null)) {
      throw new LocalManagedMessageError("The managed target changed before message admission. Refresh and review the message before sending.");
    }
  }
  const owner = readInboxOwner(db, admission.sessionId);
  if (admission.kind === "steer") assertSteerTarget(db, admission.sessionId, admission.expectedTurnId);
  if (admission.kind === "steer") assertCorrectionBudget(db, admission.expectedTurnId!, admission.body);

  const count = db.get<{ count: number }>("SELECT count(*) AS count FROM task_inputs WHERE session_id = ? AND state = 'pending'", [admission.sessionId])!.count;
  if (count >= TASK_INBOX_MAX_PENDING) throw new Error("The task inbox is full. Wait for delivery before sending more input.");
  const timestamp = new Date().toISOString();
  const input = TaskInputSchema.parse({
    ...admission, sequence: 0, revision: 1, state: "pending", requestIds: [], error: null,
    payload: { ...admission.payload, ...(admission.payload.remoteDevice ? { remoteDeviceExecution: remoteExecutionSnapshot(session) } : {}) },
    turnId: admission.kind !== "queued" && admission.kind !== "followup" && owner?.accepting && !owner.paused && owner.lease_until > Date.now()
      ? owner.turn_id : null,
    createdAt: timestamp, updatedAt: timestamp,
  });
  if (admission.payload.remoteDevice !== undefined) {
    const command = admission.payload.remoteDevice as RemoteDispatchCommand;
    if (command.payload.resume === true && (admission.kind !== "queued" || admission.expectedTurnId !== command.expectedTurnId))
      throw new Error("remote_resume_input_invalid");
    resumeRemoteTaskInput(db, command);
  }
  db.run("INSERT INTO task_inputs (id, session_id, sender_key, idempotency_key, kind, state, turn_id, payload, admission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    input.id, input.sessionId, senderKey, input.idempotencyKey, input.kind, input.state, input.turnId, JSON.stringify(input), JSON.stringify(admission),
  ]);
  return readTaskInput(db, input.id)!;
}

export function pendingTaskInputs(db: OpenPondSqliteConnection, sessionId: string, turnId: string): TaskInput[] {
  return db.all<InputRow>(
    `SELECT sequence, payload FROM task_inputs WHERE session_id = ? AND state = 'pending'
     AND ((turn_id = ?) OR (turn_id IS NULL AND kind NOT IN ('queued', 'followup', 'steer')))
     ORDER BY sequence`, [sessionId, turnId],
  ).map(inputFromRow);
}

export function assertCorrectionBudget(db: OpenPondSqliteConnection, turnId: string, body: string): void {
  const size = db.get<{ size: number }>(`SELECT COALESCE(SUM(length(json_extract(payload, '$.body'))), 0) AS size
    FROM task_inputs WHERE turn_id = ? AND kind = 'steer' AND state NOT IN ('rejected', 'cancelled')`, [turnId])!.size;
  if (size + body.length > 64_000) throw new Error("This turn's correction history is full. Finish it or send the additional instructions in a new turn.");
}
