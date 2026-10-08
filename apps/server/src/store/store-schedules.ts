import type { LocalAgentSchedule, LocalAgentScheduleRun, LocalAgentScheduleRunStatus } from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { localAgentScheduleFromRow, localAgentScheduleParams, localAgentScheduleRunFromRow, localAgentScheduleRunParams } from "./store-codecs.js";
import { SqliteStoreDomain } from "./store-domain.js";

type LocalAgentScheduleRow = PayloadRow & {
  id: string;
  local_project_id: string;
  schedule_name: string;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type LocalAgentScheduleRunRow = PayloadRow & {
  id: string;
  schedule_id: string;
  local_project_id: string;
  schedule_name: string;
  scheduled_for: string;
  trigger: LocalAgentScheduleRun["trigger"];
  status: LocalAgentScheduleRunStatus;
  created_at: string;
  updated_at: string;
};

export class SqliteScheduleStore extends SqliteStoreDomain {


  async listLocalAgentSchedules(query: {
    localProjectId?: string | null;
    enabled?: boolean | null;
  } = {}): Promise<LocalAgentSchedule[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.localProjectId) {
      where.push("local_project_id = ?");
      params.push(query.localProjectId);
    }
    if (query.enabled !== undefined && query.enabled !== null) {
      where.push("enabled = ?");
      params.push(query.enabled ? 1 : 0);
    }
    const rows = await this.all<LocalAgentScheduleRow>(
      `SELECT * FROM local_agent_schedules
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY local_project_id ASC, schedule_name ASC`,
      params,
    );
    return rows.map(localAgentScheduleFromRow);
  }

  async listDueLocalAgentSchedules(nowIso: string, limit = 25): Promise<LocalAgentSchedule[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<LocalAgentScheduleRow>(
      `SELECT * FROM local_agent_schedules
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
      [nowIso, Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    return rows.map(localAgentScheduleFromRow);
  }

  async getLocalAgentSchedule(id: string): Promise<LocalAgentSchedule | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<LocalAgentScheduleRow>(
      "SELECT * FROM local_agent_schedules WHERE id = ?",
      [id],
    );
    return row ? localAgentScheduleFromRow(row) : null;
  }

  async upsertLocalAgentSchedule(schedule: LocalAgentSchedule): Promise<LocalAgentSchedule> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO local_agent_schedules (
           id,
           local_project_id,
           schedule_name,
           enabled,
           next_run_at,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           local_project_id = excluded.local_project_id,
           schedule_name = excluded.schedule_name,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        localAgentScheduleParams(schedule),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getLocalAgentSchedule(schedule.id)) ?? schedule;
  }

  async deleteLocalAgentSchedulesNotIn(
    localProjectId: string,
    scheduleIds: string[],
  ): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      if (scheduleIds.length === 0) {
        await this.run("DELETE FROM local_agent_schedules WHERE local_project_id = ?", [localProjectId]);
        return;
      }
      const placeholders = scheduleIds.map(() => "?").join(", ");
      await this.run(
        `DELETE FROM local_agent_schedules
         WHERE local_project_id = ?
           AND id NOT IN (${placeholders})`,
        [localProjectId, ...scheduleIds],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async patchLocalAgentSchedule(
    id: string,
    updater: (schedule: LocalAgentSchedule) => LocalAgentSchedule,
  ): Promise<LocalAgentSchedule | null> {
    await this.ready;
    let updated: LocalAgentSchedule | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<LocalAgentScheduleRow>(
        "SELECT * FROM local_agent_schedules WHERE id = ?",
        [id],
      );
      if (!row) return;
      updated = updater(localAgentScheduleFromRow(row));
      await this.run(
        `UPDATE local_agent_schedules
         SET enabled = ?,
             next_run_at = ?,
             payload = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          updated.enabled ? 1 : 0,
          updated.nextRunAt,
          JSON.stringify(updated),
          updated.updatedAt,
          id,
        ],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async insertLocalAgentScheduleRun(
    run: LocalAgentScheduleRun,
  ): Promise<LocalAgentScheduleRun> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO local_agent_schedule_runs (
           id,
           schedule_id,
           local_project_id,
           schedule_name,
           scheduled_for,
           trigger,
           status,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        localAgentScheduleRunParams(run),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getLocalAgentScheduleRun(run.id)) ?? run;
  }

  async getLocalAgentScheduleRun(id: string): Promise<LocalAgentScheduleRun | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<LocalAgentScheduleRunRow>(
      "SELECT * FROM local_agent_schedule_runs WHERE id = ?",
      [id],
    );
    return row ? localAgentScheduleRunFromRow(row) : null;
  }

  async listLocalAgentScheduleRuns(
    scheduleId: string,
    limit = 25,
  ): Promise<LocalAgentScheduleRun[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<LocalAgentScheduleRunRow>(
      `SELECT * FROM local_agent_schedule_runs
       WHERE schedule_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [scheduleId, Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    return rows.map(localAgentScheduleRunFromRow);
  }

  async patchLocalAgentScheduleRun(
    id: string,
    updater: (run: LocalAgentScheduleRun) => LocalAgentScheduleRun,
  ): Promise<LocalAgentScheduleRun | null> {
    await this.ready;
    let updated: LocalAgentScheduleRun | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<LocalAgentScheduleRunRow>(
        "SELECT * FROM local_agent_schedule_runs WHERE id = ?",
        [id],
      );
      if (!row) return;
      updated = updater(localAgentScheduleRunFromRow(row));
      await this.run(
        `UPDATE local_agent_schedule_runs
         SET status = ?,
             payload = ?,
             updated_at = ?
         WHERE id = ?`,
        [updated.status, JSON.stringify(updated), updated.updatedAt, id],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }
}
