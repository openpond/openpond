import { ChatWorkflowSchema } from "@openpond/contracts";
import { nextOccurrence } from "../workflows/chat-workflow-scheduler.js";
import { withLocalDatabase } from "@openpond/persistence";

/** Called only by the home owner, before admitting work or starting scheduler loops. */
export function reconcileInterruptedScheduledWork(home: string): { recovered: number; needsReview: number } {
  return withLocalDatabase(home, (db) => {
    let recovered = 0, needsReview = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [runs, schedules, ownerField] of [
        ["local_agent_schedule_runs", "local_agent_schedules", "scheduleId"],
        ["chat_workflow_runs", "chat_workflows", "workflowId"],
      ] as const) {
        const rows = db.prepare(`SELECT id, payload FROM ${runs} WHERE status IN ('queued','running')`).all() as { id: string; payload: string }[];
        for (const row of rows) {
          const run = JSON.parse(row.payload) as Record<string, unknown>;
          const completedAt = new Date().toISOString();
          const turn = typeof run.turnId === "string" ? db.prepare("SELECT payload FROM turns WHERE id = ?").get(run.turnId) as { payload: string } | undefined : undefined;
          const turnState = turn ? JSON.parse(turn.payload) as { status?: string } : null;
          const confirmed = turnState?.status === "completed";
          const error = confirmed
            ? "The previous scheduled turn completed before shutdown."
            : "OpenPond stopped before this scheduled run was settled. Its external outcome may be unknown. Review the run before retrying or enabling this schedule.";
          const status = confirmed ? "succeeded" : "failed";
          db.prepare(`UPDATE ${runs} SET status=?, payload=?, updated_at=? WHERE id=?`).run(status, JSON.stringify({ ...run, status, error: confirmed ? null : error, completedAt, updatedAt: completedAt }), completedAt, row.id);
          const scheduleRow = db.prepare(`SELECT payload FROM ${schedules} WHERE id = ?`).get(String(run[ownerField])) as { payload: string } | undefined;
          if (scheduleRow && !confirmed) {
            const schedule = JSON.parse(scheduleRow.payload) as Record<string, unknown>;
            db.prepare(`UPDATE ${schedules} SET enabled=0, next_run_at=NULL, payload=?, updated_at=? WHERE id=?`).run(JSON.stringify({ ...schedule, enabled: false, nextRunAt: null, lastRunStatus: status, lastRunId: row.id, lastError: error, updatedAt: completedAt }), completedAt, String(run[ownerField]));
          }
          if (confirmed && scheduleRow && schedules === "chat_workflows") {
            const schedule = ChatWorkflowSchema.parse(JSON.parse(scheduleRow.payload));
            const scheduledRunCount = schedule.scheduledRunCount + (run.trigger === "schedule" ? 1 : 0);
            const nextRunAt = run.trigger === "manual" ? schedule.nextRunAt : nextOccurrence(schedule.recurrence, new Date(completedAt), scheduledRunCount);
            const enabled = schedule.enabled && nextRunAt !== null;
            db.prepare(`UPDATE chat_workflows SET enabled=?, next_run_at=?, payload=?, updated_at=? WHERE id=?`).run(enabled ? 1 : 0, enabled ? nextRunAt : null, JSON.stringify({ ...schedule, enabled, nextRunAt: enabled ? nextRunAt : null, scheduledRunCount, lastRunStatus: status, lastRunId: row.id, lastRunAt: completedAt, lastError: null, updatedAt: completedAt }), completedAt, schedule.id);
          }
          if (confirmed) recovered += 1; else needsReview += 1;
        }
      }
      db.exec("COMMIT"); return { recovered, needsReview };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
