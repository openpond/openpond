import {
  TASK_INPUT_BATCH_MAX_CHARS, TaskInputMutationSchema, TaskWaitSchema,
  SubagentRunSchema, type SubagentRun,
  type TaskInboxSnapshot, type TaskInput, type TaskInputAdmission, type TaskInputMutation, type TaskWait,
} from "@openpond/contracts";
import { recoverTaskInboxOwners } from "./task-inbox-recovery.js";
import { SqliteChatWorkflowStore } from "./store-chat-workflows.js";
import { subagentRunParams } from "./store-codecs.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import {
  admitTaskInput, assertCorrectionBudget, assertSteerTarget, inputFromRow, pendingTaskInputs, readInboxOwner,
  readTaskInput, requireInboxOwner, writeTaskInput,
} from "./task-inbox-records.js";

const LEASE_MS = 90_000;

export class SqliteTaskInboxStore extends SqliteChatWorkflowStore {
  private async inboxWrite<T>(operation: (db: OpenPondSqliteConnection) => T): Promise<T> {
    await this.ready;
    const write = this.writeQueue.then(() => {
      const db = this.database;
      db.exec("BEGIN IMMEDIATE");
      try { const value = operation(db); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = write.then(() => {}, () => {});
    return write;
  }

  async recoverTaskInboxOwners(ownerId: string): Promise<Array<{ sessionId: string; turnId: string }>> {
    return this.inboxWrite((db) => recoverTaskInboxOwners(db, ownerId));
  }

  async hasTaskCompletion(turnId: string): Promise<boolean> {
    await this.ready; await this.writeQueue;
    return Boolean(this.database.get("SELECT turn_id FROM task_completion_outbox WHERE turn_id = ?", [turnId]));
  }

  async taskInboxSnapshot(sessionId: string): Promise<TaskInboxSnapshot> {
    await this.ready; await this.writeQueue;
    const owner = readInboxOwner(this.database, sessionId);
    const active = owner && owner.lease_until > Date.now()
      && this.database.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [owner.turn_id])?.status === "in_progress";
    const rows = this.database.all<{ sequence: number; payload: string }>(
      `SELECT sequence, payload FROM task_inputs WHERE session_id = ? AND (state IN ('pending', 'included')
       OR sequence IN (SELECT sequence FROM task_inputs WHERE session_id = ? ORDER BY sequence DESC LIMIT 30)) ORDER BY sequence`, [sessionId, sessionId]);
    return { sessionId, activeTurnId: active ? owner.turn_id : null, acceptingInput: Boolean(active && owner.accepting && !owner.paused),
      paused: Boolean(owner?.paused), inputs: rows.map(inputFromRow), waits: await this.taskWaitsForSession(sessionId) };
  }

  async declareTaskWork(sessionId: string, turnId: string, ownerId: string, areas: string[]): Promise<void> {
    return this.inboxWrite((db) => {
      requireInboxOwner(db, sessionId, turnId, ownerId);
      db.run("INSERT INTO task_work_claims (session_id, turn_id, work_areas) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id, work_areas = excluded.work_areas",
        [sessionId, turnId, JSON.stringify(areas)]);
    });
  }

  async taskWorkAreas(sessionId: string): Promise<string[]> {
    await this.ready; await this.writeQueue;
    const row = this.database.get<{ work_areas: string }>("SELECT c.work_areas FROM task_work_claims c JOIN task_inbox_turns t ON c.session_id = t.session_id AND c.turn_id = t.turn_id WHERE c.session_id = ? AND t.lease_until > ?", [sessionId, Date.now()]);
    return row ? JSON.parse(row.work_areas) as string[] : [];
  }

  async admitTaskInput(input: TaskInputAdmission): Promise<TaskInput> {
    return this.inboxWrite((db) => admitTaskInput(db, input));
  }

  async admitTaskInputs(inputs: TaskInputAdmission[]): Promise<TaskInput[]> {
    return this.inboxWrite((db) => inputs.map((input) => admitTaskInput(db, input)));
  }

  async rejectTaskInput(id: string, error: string): Promise<void> {
    return this.inboxWrite((db) => {
      const input = readTaskInput(db, id);
      if (input?.state === "pending") writeTaskInput(db, { ...input, state: "rejected", error, updatedAt: new Date().toISOString() });
    });
  }

  async getTaskInput(id: string): Promise<TaskInput | null> {
    await this.ready; await this.writeQueue;
    return readTaskInput(this.database, id);
  }

  async taskInputsForSession(sessionId: string, query: { afterSequence?: number; pendingOnly?: boolean; limit?: number } = {}): Promise<TaskInput[]> {
    await this.ready; await this.writeQueue;
    return this.database.all<{ sequence: number; payload: string }>(
      `SELECT sequence, payload FROM task_inputs WHERE session_id = ? AND sequence > ?
       ${query.pendingOnly ? "AND state = 'pending'" : ""} ORDER BY sequence LIMIT ?`,
      [sessionId, query.afterSequence ?? 0, Math.max(1, Math.min(500, query.limit ?? 128))],
    ).map(inputFromRow);
  }

  async mutateTaskInput(sessionId: string, inputId: string, change: TaskInputMutation): Promise<TaskInput> {
    const mutation = TaskInputMutationSchema.parse(change);
    return this.inboxWrite((db) => {
      const input = readTaskInput(db, inputId);
      if (!input || input.sessionId !== sessionId || input.senderKind !== "user") throw new Error("Queued user input not found.");
      if (input.state !== "pending" || input.revision !== mutation.expectedRevision || input.turnId) {
        throw new Error("This input changed or has already been admitted. Refresh the queue before editing it.");
      }
      if (mutation.action === "resume") {
        if (input.kind !== "queued") throw new Error("Only the user queue can be resumed here.");
        const owner = readInboxOwner(db, sessionId);
        if (owner && owner.lease_until > Date.now()) throw new Error("This task is already running.");
        db.run("UPDATE task_inbox_turns SET paused = 0 WHERE session_id = ?", [sessionId]);
      }
      if (mutation.action === "steer") {
        assertSteerTarget(db, sessionId, mutation.expectedTurnId);
        assertCorrectionBudget(db, mutation.expectedTurnId, input.body);
      }
      return writeTaskInput(db, {
        ...input, revision: input.revision + 1, updatedAt: new Date().toISOString(),
        ...(mutation.action === "cancel" ? { state: "cancelled" as const } : {}),
        ...(mutation.action === "edit" ? { body: mutation.body, payload: { ...input.payload, prompt: mutation.body } } : {}),
        ...(mutation.action === "steer" ? { kind: "steer" as const, expectedTurnId: mutation.expectedTurnId, turnId: mutation.expectedTurnId } : {}),
      });
    });
  }

  async openTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<void> {
    return this.inboxWrite((db) => {
      const owner = readInboxOwner(db, sessionId);
      if (owner && owner.lease_until > Date.now() && (owner.turn_id !== turnId || owner.owner_id !== ownerId)) {
        throw new Error("A turn is already running for this task.");
      }
      db.run(`INSERT INTO task_inbox_turns (session_id, turn_id, owner_id, generation, accepting, paused, lease_until)
        VALUES (?, ?, ?, ?, 1, 0, ?) ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id,
        owner_id = excluded.owner_id, generation = excluded.generation, accepting = 1, paused = 0, lease_until = excluded.lease_until`,
      [sessionId, turnId, ownerId, (owner?.generation ?? 0) + 1, Date.now() + LEASE_MS]);
    });
  }

  async renewTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<void> {
    return this.inboxWrite((db) => {
      requireInboxOwner(db, sessionId, turnId, ownerId);
      db.run("UPDATE task_inbox_turns SET lease_until = ? WHERE session_id = ?", [Date.now() + LEASE_MS, sessionId]);
    });
  }

  async pendingTaskInputs(sessionId: string, turnId: string): Promise<TaskInput[]> {
    await this.ready; await this.writeQueue;
    return pendingTaskInputs(this.database, sessionId, turnId);
  }

  async taskAssignmentInputs(turnId: string): Promise<TaskInput[]> {
    await this.ready; await this.writeQueue;
    return this.database.all<{ sequence: number; payload: string }>(
      "SELECT sequence, payload FROM task_inputs WHERE turn_id = ? AND kind = 'steer' AND state IN ('included', 'resolved') ORDER BY sequence", [turnId],
    ).map(inputFromRow);
  }

  async pauseTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<void> {
    return this.inboxWrite((db) => {
      requireInboxOwner(db, sessionId, turnId, ownerId);
      db.run("UPDATE task_inbox_turns SET accepting = 0, paused = 1 WHERE session_id = ?", [sessionId]);
    });
  }

  /** Manifest and inclusion receipts commit before provider dispatch. */
  async includeTaskInputs(sessionId: string, turnId: string, ownerId: string, requestId: string): Promise<TaskInput[]> {
    return this.inboxWrite((db) => {
      requireInboxOwner(db, sessionId, turnId, ownerId);
      const previous = db.get<{ input_ids: string }>("SELECT input_ids FROM task_input_requests WHERE request_id = ?", [requestId]);
      if (previous) return (JSON.parse(previous.input_ids) as string[]).map((id) => readTaskInput(db, id)!);
      let remaining = TASK_INPUT_BATCH_MAX_CHARS;
      const included: TaskInput[] = [];
      for (const input of pendingTaskInputs(db, sessionId, turnId)) {
        if (input.body.length > remaining || included.length >= 32) break;
        remaining -= input.body.length;
        included.push(writeTaskInput(db, { ...input, state: "included", turnId,
          requestIds: [...input.requestIds, requestId], updatedAt: new Date().toISOString() }));
      }
      db.run("INSERT INTO task_input_requests (request_id, session_id, turn_id, input_ids, state, created_at) VALUES (?, ?, ?, ?, 'included', ?)",
        [requestId, sessionId, turnId, JSON.stringify(included.map((input) => input.id)), new Date().toISOString()]);
      return included;
    });
  }

  async settleTaskInputRequest(requestId: string, outcome: "resolved" | "failed" | "replaced"): Promise<void> {
    return this.inboxWrite((db) => {
      const request = db.get<{ input_ids: string }>("SELECT input_ids FROM task_input_requests WHERE request_id = ?", [requestId]);
      if (!request) return;
      db.run("UPDATE task_input_requests SET state = ? WHERE request_id = ?", [outcome, requestId]);
      for (const id of JSON.parse(request.input_ids) as string[]) {
        const input = readTaskInput(db, id);
        if (!input || input.state !== "included") continue;
        writeTaskInput(db, { ...input, state: outcome === "resolved" ? "resolved" : outcome === "replaced" ? "pending" : "included",
          error: outcome === "failed" ? "Provider request failed after input inclusion; receipt is not evidence of a reply." : null,
          updatedAt: new Date().toISOString() });
      }
    });
  }

  /** Serializes the last empty-inbox check with admission. A stale steer cannot slip past it. */
  async sealTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<boolean> {
    return this.inboxWrite((db) => {
      requireInboxOwner(db, sessionId, turnId, ownerId);
      if (pendingTaskInputs(db, sessionId, turnId).length) return false;
      db.run("UPDATE task_inbox_turns SET accepting = 0 WHERE session_id = ?", [sessionId]);
      return true;
    });
  }

  async sealNativeTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<TaskInput[]> {
    return this.inboxWrite((db) => {
      requireInboxOwner(db, sessionId, turnId, ownerId);
      db.run("UPDATE task_inbox_turns SET accepting = 0 WHERE session_id = ?", [sessionId]);
      return pendingTaskInputs(db, sessionId, turnId).map((input) => writeTaskInput(db, {
        ...input, updatedAt: new Date().toISOString(),
        ...(input.kind === "steer"
          ? { state: "rejected", error: "Codex finished before this correction could be dispatched. Send it as a follow-up." }
          : { turnId: null }),
      }));
    });
  }

  async closeTaskInboxTurn(sessionId: string, turnId: string, ownerId: string, outcome: "completed" | "failed" | "interrupted"): Promise<void> {
    return this.inboxWrite((db) => {
      const owner = readInboxOwner(db, sessionId);
      if (!owner || owner.turn_id !== turnId || owner.owner_id !== ownerId) return;
      db.run("UPDATE task_inbox_turns SET accepting = 0, paused = CASE WHEN ? = 1 THEN 1 ELSE paused END, lease_until = 0 WHERE session_id = ?", [outcome === "completed" ? 0 : 1, sessionId]);
      for (const input of pendingTaskInputs(db, sessionId, turnId)) {
        if (input.kind === "steer") writeTaskInput(db, { ...input, state: "rejected", error: `Turn ${outcome} before this correction was included. Send it as a follow-up.`, updatedAt: new Date().toISOString() });
        else if (input.turnId === turnId) writeTaskInput(db, { ...input, turnId: null, updatedAt: new Date().toISOString() });
      }
    });
  }

  async taskInboxPaused(sessionId: string): Promise<boolean> {
    await this.ready; await this.writeQueue;
    return Boolean(readInboxOwner(this.database, sessionId)?.paused);
  }

  /** Assign a queued input to a known turn before starting; retries cannot start it twice. */
  async reserveTaskFollowup(sessionId: string, turnId: string, ownerId: string): Promise<TaskInput | null> {
    return this.inboxWrite((db) => {
      const owner = readInboxOwner(db, sessionId);
      if (owner?.paused || (owner && owner.lease_until > Date.now())) return null;
      const row = db.get<{ sequence: number; payload: string }>(
        "SELECT sequence, payload FROM task_inputs WHERE session_id = ? AND state = 'pending' AND turn_id IS NULL AND kind IN ('queued', 'followup') ORDER BY sequence LIMIT 1", [sessionId]);
      if (!row) return null;
      db.run(`INSERT INTO task_inbox_turns (session_id, turn_id, owner_id, generation, accepting, paused, lease_until)
        VALUES (?, ?, ?, ?, 1, 0, ?) ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id,
        owner_id = excluded.owner_id, generation = excluded.generation, accepting = 1, paused = 0, lease_until = excluded.lease_until`,
      [sessionId, turnId, ownerId, (owner?.generation ?? 0) + 1, Date.now() + LEASE_MS]);
      return writeTaskInput(db, { ...inputFromRow(row), turnId, updatedAt: new Date().toISOString() });
    });
  }

  async taskInboxWakeTargets(): Promise<string[]> {
    await this.ready; await this.writeQueue;
    return this.database.all<{ session_id: string }>(
      `SELECT DISTINCT i.session_id FROM task_inputs i LEFT JOIN task_inbox_turns t ON t.session_id = i.session_id
       WHERE i.state = 'pending' AND i.turn_id IS NULL AND i.kind IN ('queued', 'followup')
       AND COALESCE(t.paused, 0) = 0 AND COALESCE(t.lease_until, 0) <= ?`, [Date.now()],
    ).map((row) => row.session_id);
  }

  async createTaskWait(value: TaskWait): Promise<TaskWait> {
    const wait = TaskWaitSchema.parse(value);
    return this.inboxWrite((db) => {
      const existing = db.get<{ payload: string }>("SELECT payload FROM task_waits WHERE id = ?", [wait.id]);
      if (existing) return TaskWaitSchema.parse(JSON.parse(existing.payload));
      if (wait.targetSessionId === wait.sessionId) throw new Error("A task cannot wait for itself.");
      if (wait.targetSessionId) {
        const cycle = db.get<{ session_id: string }>(`WITH RECURSIVE dependencies(session_id) AS (
          SELECT target_session_id FROM task_waits WHERE session_id = ? AND state = 'waiting'
          UNION SELECT w.target_session_id FROM task_waits w JOIN dependencies d ON w.session_id = d.session_id WHERE w.state = 'waiting'
        ) SELECT session_id FROM dependencies WHERE session_id = ? LIMIT 1`, [wait.targetSessionId, wait.sessionId]);
        if (cycle) throw new Error("This dependency would create a task wait cycle. Coordinate a different order.");
      }
      db.run("INSERT INTO task_waits (id, session_id, turn_id, target_session_id, target_turn_id, state, deadline, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [wait.id, wait.sessionId, wait.turnId, wait.targetSessionId, wait.targetTurnId, wait.state, wait.deadline, JSON.stringify(wait)]);
      return wait;
    });
  }

  async settleTaskWait(id: string, state: TaskWait["state"]): Promise<TaskWait> {
    return this.inboxWrite((db) => {
      const row = db.get<{ payload: string }>("SELECT payload FROM task_waits WHERE id = ?", [id]);
      if (!row) throw new Error("Task wait not found.");
      const wait = TaskWaitSchema.parse(JSON.parse(row.payload));
      if (wait.state !== "waiting") return wait;
      const next = { ...wait, state, updatedAt: new Date().toISOString() };
      db.run("UPDATE task_waits SET state = ?, payload = ? WHERE id = ?", [state, JSON.stringify(next), id]);
      return next;
    });
  }

  async taskWaitsForSession(sessionId: string): Promise<TaskWait[]> {
    await this.ready; await this.writeQueue;
    return this.database.all<{ payload: string }>("SELECT payload FROM task_waits WHERE session_id = ? AND state = 'waiting'", [sessionId])
      .map((row) => TaskWaitSchema.parse(JSON.parse(row.payload)));
  }

  /** Final child outcome and notification intent cannot be separated by a crash. */
  async commitSubagentCompletion(value: SubagentRun, turnId: string): Promise<void> {
    const run = SubagentRunSchema.parse(value);
    return this.inboxWrite((db) => {
      const timestamp = new Date().toISOString();
      db.run(`INSERT INTO subagent_runs (id, parent_session_id, parent_turn_id, child_session_id, role_id, status, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status,
        payload = excluded.payload, updated_at = excluded.updated_at`, subagentRunParams(run, timestamp));
      db.run("INSERT INTO task_completion_outbox (turn_id, run_id, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(turn_id) DO NOTHING", [turnId, run.id, JSON.stringify(run), timestamp]);
    });
  }

  async pendingTaskCompletions(afterTurnId = ""): Promise<Array<{ turnId: string; run: SubagentRun }>> {
    await this.ready; await this.writeQueue;
    return this.database.all<{ turn_id: string; payload: string }>("SELECT turn_id, payload FROM task_completion_outbox WHERE input_id IS NULL AND turn_id > ? ORDER BY turn_id LIMIT 100", [afterTurnId])
      .map((row) => ({ turnId: row.turn_id, run: SubagentRunSchema.parse(JSON.parse(row.payload)) }));
  }

  async settleTaskCompletion(turnId: string, inputId: string): Promise<void> {
    return this.inboxWrite((db) => {
      if (!readTaskInput(db, inputId)) throw new Error("Completion delivery has no durable input receipt.");
      db.run("UPDATE task_completion_outbox SET input_id = ? WHERE turn_id = ? AND input_id IS NULL", [inputId, turnId]);
    });
  }
}

export type TaskInboxRepository = Pick<SqliteTaskInboxStore,
  "taskInboxSnapshot" | "declareTaskWork" | "taskWorkAreas" | "recoverTaskInboxOwners" | "hasTaskCompletion" | "admitTaskInput" | "admitTaskInputs" | "rejectTaskInput" | "getTaskInput" | "taskInputsForSession" | "mutateTaskInput" |
  "openTaskInboxTurn" | "renewTaskInboxTurn" | "pendingTaskInputs" | "taskAssignmentInputs" | "pauseTaskInboxTurn" | "includeTaskInputs" |
  "settleTaskInputRequest" | "sealNativeTaskInboxTurn" | "sealTaskInboxTurn" | "closeTaskInboxTurn" | "taskInboxPaused" |
  "reserveTaskFollowup" | "taskInboxWakeTargets" | "createTaskWait" | "settleTaskWait" | "taskWaitsForSession"
  | "commitSubagentCompletion" | "pendingTaskCompletions" | "settleTaskCompletion"
>;
