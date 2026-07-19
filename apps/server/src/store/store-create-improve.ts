import {
  CreateImproveRunSchema,
  type CreateImproveRun,
  type CreateImproveRunAction,
} from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { SqliteTrainingStore } from "./store-training.js";

export class SqliteCreateImproveStore extends SqliteTrainingStore {
  async getCreateImproveRun(runId: string): Promise<CreateImproveRun | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM create_improve_runs WHERE id = ?",
      [runId],
    );
    return row ? CreateImproveRunSchema.parse(JSON.parse(row.payload)) : null;
  }

  async listCreateImproveRuns(query: {
    profileId?: string | null;
    conversationId?: string | null;
    targetKind?: CreateImproveRun["target"]["kind"] | null;
    targetId?: string | null;
    state?: CreateImproveRun["state"] | readonly CreateImproveRun["state"][] | null;
    limit?: number;
  } = {}): Promise<CreateImproveRun[]> {
    await this.ready;
    await this.writeQueue;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.profileId) {
      clauses.push("profile_id = ?");
      params.push(query.profileId);
    }
    if (query.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(query.conversationId);
    }
    if (query.targetKind) {
      clauses.push("target_kind = ?");
      params.push(query.targetKind);
    }
    if (query.targetId) {
      clauses.push("target_id = ?");
      params.push(query.targetId);
    }
    const states = Array.isArray(query.state)
      ? query.state
      : query.state
        ? [query.state]
        : [];
    if (states.length > 0) {
      clauses.push(`state IN (${states.map(() => "?").join(", ")})`);
      params.push(...states);
    }
    const limit = Math.max(1, Math.min(1_000, Math.trunc(query.limit ?? 250)));
    params.push(limit);
    const rows = await this.all<PayloadRow>(
      `SELECT payload
       FROM create_improve_runs
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY updated_at DESC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => CreateImproveRunSchema.parse(JSON.parse(row.payload)));
  }

  async upsertCreateImproveRun(run: CreateImproveRun): Promise<CreateImproveRun> {
    await this.ready;
    const parsed = CreateImproveRunSchema.parse(run);
    const write = this.writeQueue.then(async () => {
      const existing = await this.get<{ revision: number }>(
        "SELECT revision FROM create_improve_runs WHERE id = ?",
        [parsed.id],
      );
      if (existing && existing.revision > parsed.revision) {
        throw new Error(
          `Create/Improve run ${parsed.id} is already at revision ${existing.revision}; refusing revision ${parsed.revision}.`,
        );
      }
      await this.assertNoCompetingCreateImproveRun(parsed);
      await this.run(
        `INSERT INTO create_improve_runs (
           id, profile_id, conversation_id, origin_turn_id, target_kind, target_id,
           state, revision, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           profile_id = excluded.profile_id,
           conversation_id = excluded.conversation_id,
           origin_turn_id = excluded.origin_turn_id,
           target_kind = excluded.target_kind,
           target_id = excluded.target_id,
           state = excluded.state,
           revision = excluded.revision,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        createImproveRunParams(parsed),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return parsed;
  }

  async mutateCreateImproveRun(
    action: CreateImproveRunAction,
    updater: (run: CreateImproveRun) => CreateImproveRun,
  ): Promise<{ run: CreateImproveRun; replayed: boolean }> {
    await this.ready;
    let result: { run: CreateImproveRun; replayed: boolean } | null = null;
    const write = this.writeQueue.then(async () => {
      const receipt = await this.get<PayloadRow>(
        "SELECT payload FROM create_improve_run_actions WHERE action_id = ?",
        [action.actionId],
      );
      if (receipt) {
        result = {
          run: CreateImproveRunSchema.parse(JSON.parse(receipt.payload)),
          replayed: true,
        };
        return;
      }
      const row = await this.get<PayloadRow & { revision: number }>(
        "SELECT revision, payload FROM create_improve_runs WHERE id = ?",
        [action.runId],
      );
      if (!row) throw new Error(`Create/Improve run not found: ${action.runId}`);
      const current = CreateImproveRunSchema.parse(JSON.parse(row.payload));
      if (current.revision !== action.expectedRevision) {
        throw new Error(
          `Create/Improve run ${action.runId} changed from revision ${action.expectedRevision} to ${current.revision}. Refresh and try again.`,
        );
      }
      const next = CreateImproveRunSchema.parse(updater(current));
      if (next.id !== current.id) throw new Error("Create/Improve mutation cannot change the run id.");
      if (next.revision !== current.revision + 1) {
        throw new Error("Create/Improve mutation must advance exactly one revision.");
      }
      if (!next.appliedActionIds.includes(action.actionId)) {
        throw new Error("Create/Improve mutation must record its action id.");
      }
      await this.assertNoCompetingCreateImproveRun(next);
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run(
          `UPDATE create_improve_runs SET
             profile_id = ?, conversation_id = ?, origin_turn_id = ?, target_kind = ?,
             target_id = ?, state = ?, revision = ?, payload = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
          [
            next.scope.profileId,
            next.scope.conversationId,
            next.scope.originTurnId,
            next.target.kind,
            next.target.id,
            next.state,
            next.revision,
            JSON.stringify(next),
            next.updatedAt,
            next.id,
            current.revision,
          ],
        );
        await this.run(
          `INSERT INTO create_improve_run_actions (
             action_id, run_id, expected_revision, resulting_revision, payload, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            action.actionId,
            action.runId,
            action.expectedRevision,
            next.revision,
            JSON.stringify(next),
            next.updatedAt,
          ],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
      result = { run: next, replayed: false };
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error(`Create/Improve mutation failed: ${action.actionId}`);
    return result;
  }

  private async assertNoCompetingCreateImproveRun(run: CreateImproveRun): Promise<void> {
    if (!run.target.id || isTerminalCreateImproveRunState(run.state)) return;
    const competing = await this.get<{ id: string }>(
      `SELECT id
       FROM create_improve_runs
       WHERE profile_id = ?
         AND target_kind = ?
         AND target_id = ?
         AND id <> ?
         AND state NOT IN (
           'released',
           'rejected',
           'ready',
           'ready_local',
           'published_hosted',
           'blocked',
           'failed',
           'cancelled'
         )
       LIMIT 1`,
      [run.scope.profileId, run.target.kind, run.target.id, run.id],
    );
    if (competing) {
      throw new Error(
        `Workproduct ${run.target.kind}:${run.target.id} already has active Create/Improve run ${competing.id}.`,
      );
    }
  }
}

function createImproveRunParams(run: CreateImproveRun): unknown[] {
  return [
    run.id,
    run.scope.profileId,
    run.scope.conversationId,
    run.scope.originTurnId,
    run.target.kind,
    run.target.id,
    run.state,
    run.revision,
    JSON.stringify(run),
    run.createdAt,
    run.updatedAt,
  ];
}

function isTerminalCreateImproveRunState(state: CreateImproveRun["state"]): boolean {
  return state === "released"
    || state === "rejected"
    || state === "ready"
    || state === "ready_local"
    || state === "published_hosted"
    || state === "blocked"
    || state === "failed"
    || state === "cancelled";
}
