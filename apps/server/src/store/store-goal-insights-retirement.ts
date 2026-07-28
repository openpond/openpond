import type { PayloadRow } from "../types.js";

type RetirementStore = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  createSubagentTables(): Promise<void>;
};

type SubagentRunRetirementRow = PayloadRow & {
  id: string;
  parent_session_id: string;
  parent_turn_id: string | null;
  child_session_id: string | null;
  role_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type SubagentMessageRetirementRow = PayloadRow & {
  id: string;
  from_run_id: string;
  to_run_id: string | null;
  to_role: string | null;
  kind: string;
  created_at: string;
};

export async function retireGoalAndInsightsStorageState(
  store: RetirementStore,
): Promise<void> {
  const sessionRows = await store.all<PayloadRow & { id: string }>(
    "SELECT id, payload FROM sessions",
  );
  const insightSessionIds = sessionRows.flatMap((row) => {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return payload.systemKind === "openpond.insights" ? [row.id] : [];
  });
  const insightSessionIdSet = new Set(insightSessionIds);
  const runRows = (await store.all<SubagentRunRetirementRow>(
    "SELECT * FROM subagent_runs",
  )).filter(
    (row) =>
      !insightSessionIdSet.has(row.parent_session_id) &&
      (!row.child_session_id || !insightSessionIdSet.has(row.child_session_id)),
  );
  const retainedRunIds = new Set(runRows.map((row) => row.id));
  const messageRows = (await store.all<SubagentMessageRetirementRow>(
    "SELECT * FROM subagent_messages",
  )).filter(
    (row) =>
      retainedRunIds.has(row.from_run_id) &&
      (!row.to_run_id || retainedRunIds.has(row.to_run_id)),
  );

  for (const sessionId of insightSessionIds) {
    await store.run("DELETE FROM model_usage_records WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM projection_thread_details WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM projection_session_shells WHERE id = ?", [sessionId]);
    await store.run("DELETE FROM projection_approvals WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM projection_latest_turns WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM approvals WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM events WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM turns WHERE session_id = ?", [sessionId]);
    await store.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
  }
  await store.run(
    `DELETE FROM model_usage_records
     WHERE request_kind IN ('insights_scan', 'insights_question', 'goal_control')`,
    [],
  );

  const localProjects = await store.get<PayloadRow>(
    `SELECT payload FROM cache_entries
     WHERE type = 'local.projects' AND cache_key = 'v1'`,
    [],
  );
  if (localProjects) {
    const payload = JSON.parse(localProjects.payload) as unknown;
    if (Array.isArray(payload)) {
      const retainedProjects = payload.filter((project) => {
        if (!project || typeof project !== "object" || Array.isArray(project)) return true;
        const record = project as Record<string, unknown>;
        return record.id !== "system_openpond_insights" &&
          record.systemKind !== "openpond.insights";
      });
      await store.run(
        `UPDATE cache_entries SET payload = ?
         WHERE type = 'local.projects' AND cache_key = 'v1'`,
        [JSON.stringify(retainedProjects)],
      );
    }
  }

  await store.exec(`
    DROP TABLE IF EXISTS insight_items;
    DROP TABLE IF EXISTS openpond_thread_goals;
    DROP TABLE IF EXISTS subagent_messages;
    DROP TABLE IF EXISTS subagent_runs;
  `);
  await store.createSubagentTables();

  for (const row of runRows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    delete payload.parentGoalId;
    if (payload.peerMessages === "goal_scoped") payload.peerMessages = "parent_scoped";
    await store.run(
      `INSERT INTO subagent_runs (
         id, parent_session_id, parent_turn_id, child_session_id, role_id,
         status, payload, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.parent_session_id,
        row.parent_turn_id,
        row.child_session_id,
        row.role_id,
        row.status,
        JSON.stringify(payload),
        row.created_at,
        row.updated_at,
      ],
    );
  }
  for (const row of messageRows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    delete payload.parentGoalId;
    await store.run(
      `INSERT INTO subagent_messages (
         id, from_run_id, to_run_id, to_role, kind, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.from_run_id,
        row.to_run_id,
        row.to_role,
        row.kind,
        JSON.stringify(payload),
        row.created_at,
      ],
    );
  }

  await store.run(
    `UPDATE cache_entries
     SET payload = replace(payload, '"goal_scoped"', '"parent_scoped"')
     WHERE instr(payload, '"goal_scoped"') > 0`,
    [],
  );
}
