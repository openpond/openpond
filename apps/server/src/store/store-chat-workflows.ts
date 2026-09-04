import type { ChatWorkflow, ChatWorkflowRun } from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { SqliteWorkEvidenceStore } from "./store-work-evidence.js";

type ChatWorkflowRow = PayloadRow & {
  id: string;
  session_id: string;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type ChatWorkflowRunRow = PayloadRow & {
  id: string;
  workflow_id: string;
  session_id: string;
  scheduled_for: string;
  trigger: ChatWorkflowRun["trigger"];
  status: ChatWorkflowRun["status"];
  created_at: string;
  updated_at: string;
};

export class SqliteChatWorkflowStore extends SqliteWorkEvidenceStore {
  async listChatWorkflows(query: { sessionId?: string | null } = {}): Promise<ChatWorkflow[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<ChatWorkflowRow>(
      `SELECT * FROM chat_workflows
       ${query.sessionId ? "WHERE session_id = ?" : ""}
       ORDER BY created_at DESC`,
      query.sessionId ? [query.sessionId] : [],
    );
    return rows.map((row) => JSON.parse(row.payload) as ChatWorkflow);
  }

  async listDueChatWorkflows(nowIso: string, limit = 25): Promise<ChatWorkflow[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<ChatWorkflowRow>(
      `SELECT * FROM chat_workflows
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC LIMIT ?`,
      [nowIso, Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    return rows.map((row) => JSON.parse(row.payload) as ChatWorkflow);
  }

  async getChatWorkflow(id: string): Promise<ChatWorkflow | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<ChatWorkflowRow>("SELECT * FROM chat_workflows WHERE id = ?", [id]);
    return row ? (JSON.parse(row.payload) as ChatWorkflow) : null;
  }

  async upsertChatWorkflow(workflow: ChatWorkflow): Promise<ChatWorkflow> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO chat_workflows
         (id, session_id, enabled, next_run_at, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        [workflow.id, workflow.sessionId, workflow.enabled ? 1 : 0, workflow.nextRunAt,
          JSON.stringify(workflow), workflow.createdAt, workflow.updatedAt],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getChatWorkflow(workflow.id)) ?? workflow;
  }

  async patchChatWorkflow(
    id: string,
    updater: (workflow: ChatWorkflow) => ChatWorkflow,
  ): Promise<ChatWorkflow | null> {
    await this.ready;
    let updated: ChatWorkflow | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<ChatWorkflowRow>("SELECT * FROM chat_workflows WHERE id = ?", [id]);
      if (!row) return;
      updated = updater(JSON.parse(row.payload) as ChatWorkflow);
      await this.run(
        "UPDATE chat_workflows SET enabled = ?, next_run_at = ?, payload = ?, updated_at = ? WHERE id = ?",
        [updated.enabled ? 1 : 0, updated.nextRunAt, JSON.stringify(updated), updated.updatedAt, id],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async deleteChatWorkflow(id: string): Promise<boolean> {
    await this.ready;
    let changed = false;
    const write = this.writeQueue.then(async () => {
      const existing = await this.get<{ id: string }>("SELECT id FROM chat_workflows WHERE id = ?", [id]);
      if (!existing) return;
      await this.run("DELETE FROM chat_workflows WHERE id = ?", [id]);
      changed = true;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return changed;
  }

  async insertChatWorkflowRun(run: ChatWorkflowRun): Promise<ChatWorkflowRun> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO chat_workflow_runs
         (id, workflow_id, session_id, scheduled_for, trigger, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [run.id, run.workflowId, run.sessionId, run.scheduledFor, run.trigger, run.status,
          JSON.stringify(run), run.createdAt, run.updatedAt],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return run;
  }

  async listChatWorkflowRuns(workflowId?: string | null, limit = 100): Promise<ChatWorkflowRun[]> {
    await this.ready;
    await this.writeQueue;
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.all<ChatWorkflowRunRow>(
      `SELECT * FROM chat_workflow_runs
       ${workflowId ? "WHERE workflow_id = ?" : ""}
       ORDER BY created_at DESC LIMIT ?`,
      workflowId ? [workflowId, boundedLimit] : [boundedLimit],
    );
    return rows.map((row) => JSON.parse(row.payload) as ChatWorkflowRun);
  }

  async patchChatWorkflowRun(
    id: string,
    updater: (run: ChatWorkflowRun) => ChatWorkflowRun,
  ): Promise<ChatWorkflowRun | null> {
    await this.ready;
    let updated: ChatWorkflowRun | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<ChatWorkflowRunRow>("SELECT * FROM chat_workflow_runs WHERE id = ?", [id]);
      if (!row) return;
      updated = updater(JSON.parse(row.payload) as ChatWorkflowRun);
      await this.run(
        "UPDATE chat_workflow_runs SET status = ?, payload = ?, updated_at = ? WHERE id = ?",
        [updated.status, JSON.stringify(updated), updated.updatedAt, id],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }
}
