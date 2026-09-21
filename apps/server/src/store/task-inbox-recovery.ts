import { TaskWaitSchema } from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { inputFromRow, writeTaskInput } from "./task-inbox-records.js";

/** Called after exclusive home ownership is acquired. Never replay uncertain tool work. */
export function recoverTaskInboxOwners(db: OpenPondSqliteConnection, ownerId: string): Array<{ sessionId: string; turnId: string }> {
  const abandoned = db.all<{ session_id: string; turn_id: string }>(
    "SELECT session_id, turn_id FROM task_inbox_turns WHERE owner_id <> ? AND lease_until > 0", [ownerId]);
  const updatedAt = new Date().toISOString();
  for (const owner of abandoned) {
    const turn = db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [owner.turn_id]);
    // An unstarted reservation is safe to retry. A started execution requires user review.
    db.run("UPDATE task_inbox_turns SET accepting = 0, paused = ?, lease_until = 0 WHERE session_id = ?",
      [turn ? 1 : 0, owner.session_id]);
    const inputs = db.all<{ sequence: number; payload: string }>(
      "SELECT sequence, payload FROM task_inputs WHERE turn_id = ? AND state IN ('pending', 'included')", [owner.turn_id]);
    for (const row of inputs) {
      const input = inputFromRow(row);
      writeTaskInput(db, { ...input, updatedAt,
        ...(input.state === "included"
          ? { error: "Execution owner stopped after inclusion. The provider outcome is uncertain; review before retrying." }
          : input.kind === "steer"
            ? { state: "rejected", error: "The interrupted execution did not include this correction. Send it as a follow-up." }
            : { turnId: null }),
      });
    }
    db.run("UPDATE task_input_requests SET state = 'failed' WHERE turn_id = ? AND state = 'included'", [owner.turn_id]);
    for (const row of db.all<{ id: string; payload: string }>(
      "SELECT id, payload FROM task_waits WHERE turn_id = ? AND state = 'waiting'", [owner.turn_id])) {
      const wait = TaskWaitSchema.parse(JSON.parse(row.payload));
      db.run("UPDATE task_waits SET state = 'unavailable', payload = ? WHERE id = ?",
        [JSON.stringify({ ...wait, state: "unavailable", updatedAt }), row.id]);
    }
  }
  return abandoned.map((owner) => ({ sessionId: owner.session_id, turnId: owner.turn_id }));
}
