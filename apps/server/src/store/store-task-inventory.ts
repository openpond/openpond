import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ModelProjectSchema, TaskDataRecordSchema, type TaskDataRecord } from "@openpond/contracts";
import { TaskInventoryItemSchema, TaskInventoryPageSchema, TaskInventoryQuerySchema, describeTaskInput, type TaskInventoryItem } from "openpond-sdk/taskset-drafts";
import { SqliteTasksetDraftStore } from "./store-taskset-drafts.js";

export interface LocalTaskInventorySource { id: string; profileId: string; hash: string; revision: number; draft: boolean; modelId: string | null }
const CursorSchema = z.object({ scope: z.string(), key: z.string(), ordinal: z.number().int().nonnegative() }).strict();
const SQL = `
CREATE TABLE IF NOT EXISTS task_inventory_sources (source_key TEXT NOT NULL, profile_id TEXT NOT NULL, source_hash TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(profile_id, source_key));
CREATE TABLE IF NOT EXISTS task_inventory_rows (profile_id TEXT NOT NULL, source_key TEXT NOT NULL, source_hash TEXT NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, split TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile_id, source_key, source_hash, ordinal));
CREATE UNIQUE INDEX IF NOT EXISTS task_inventory_task_identity ON task_inventory_rows(profile_id, source_key, source_hash, task_id);
CREATE INDEX IF NOT EXISTS task_inventory_list ON task_inventory_rows(profile_id, source_key, source_hash, split, ordinal);
`;

/** Rebuildable projections keep list queries independent of private source files. */
export class SqliteTaskInventoryStore extends SqliteTasksetDraftStore {
  private async inventoryReady() { await this.ready; await this.writeQueue; this.database.exec(SQL); }

  async taskInventorySources(profileId: string, projectId?: string): Promise<LocalTaskInventorySource[]> {
    await this.inventoryReady();
    let attached: Set<string> | null = null;
    if (projectId) {
      const row = this.database.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ? AND profile_id = ?", [projectId, profileId]);
      if (!row) throw new Error("Model not found in this Profile.");
      const model = ModelProjectSchema.parse(JSON.parse(row.payload));
      attached = new Set(model.tasksetSyncs.map(sync => sync.localTasksetId));
      if (model.trainingSetup.tasksetRef) attached.add(model.trainingSetup.tasksetRef.id);
    }
    const releases = this.database.all<{ id: string; hash: string; revision: number }>("SELECT id, json_extract(payload, '$.contentHash') AS hash, json_extract(payload, '$.revision') AS revision FROM tasksets WHERE profile_id = ? ORDER BY id", [profileId]);
    const drafts = this.database.all<{ id: string; hash: string; revision: number; modelId: string | null }>("SELECT id, json_extract(payload, '$.packageHash') AS hash, revision, json_extract(payload, '$.modelScope.modelId') AS modelId FROM taskset_drafts WHERE profile_id = ? AND status != 'published' ORDER BY id", [profileId]);
    // A deleted draft must not leave a separately readable private cache.
    this.database.run("DELETE FROM task_inventory_rows WHERE profile_id=? AND source_key NOT IN (SELECT 'release:' || id FROM tasksets WHERE profile_id=? UNION SELECT 'draft:' || id FROM taskset_drafts WHERE profile_id=? AND status != 'published')", [profileId, profileId, profileId]);
    this.database.run("DELETE FROM task_inventory_sources WHERE profile_id=? AND source_key NOT IN (SELECT 'release:' || id FROM tasksets WHERE profile_id=? UNION SELECT 'draft:' || id FROM taskset_drafts WHERE profile_id=? AND status != 'published')", [profileId, profileId, profileId]);
    return [...releases.filter(row => !attached || attached.has(row.id)).map(row => ({ ...row, profileId, draft: false, modelId: projectId ?? null })),
      ...drafts.filter(row => !projectId || row.modelId === projectId).map(row => ({ ...row, profileId, draft: true }))].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
  }

  async taskInventorySourceIndexed(source: LocalTaskInventorySource) {
    await this.inventoryReady();
    const row = this.database.get<{ source_hash: string }>("SELECT source_hash FROM task_inventory_sources WHERE profile_id = ? AND source_key = ?", [source.profileId, sourceKey(source)]);
    return row?.source_hash === source.hash;
  }

  async appendTaskInventoryRows(source: LocalTaskInventorySource, tasks: TaskDataRecord[], offset: number) {
    await this.inventoryReady();
    const operation = this.writeQueue.then(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, task] of tasks.entries()) {
          const description = describeTaskInput(task.input, task.id);
          this.database.run("INSERT INTO task_inventory_rows (profile_id, source_key, source_hash, task_id, ordinal, title, description, split, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, source_key, source_hash, ordinal) DO UPDATE SET task_id=excluded.task_id, title=excluded.title, description=excluded.description, split=excluded.split, payload=excluded.payload",
            [source.profileId, sourceKey(source), source.hash, task.id, offset + index, description.title, description.description, task.split, JSON.stringify(task)]);
        }
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async finishTaskInventorySource(source: LocalTaskInventorySource, metadata: Pick<TaskInventoryItem, "tasksetName" | "scoring" | "configuration">) {
    await this.inventoryReady();
    const operation = this.writeQueue.then(() => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.database.get<{ hash: string }>(source.draft
          ? "SELECT json_extract(payload, '$.packageHash') AS hash FROM taskset_drafts WHERE id = ? AND profile_id = ? AND status != 'published'"
          : "SELECT json_extract(payload, '$.contentHash') AS hash FROM tasksets WHERE id = ? AND profile_id = ?", [source.id, source.profileId]);
        if (current?.hash !== source.hash) throw new Error("Tasks changed while indexing. Reload the task list.");
        this.database.run("INSERT INTO task_inventory_sources (profile_id, source_key, source_hash, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, source_key) DO UPDATE SET source_hash=excluded.source_hash, metadata=excluded.metadata", [source.profileId, sourceKey(source), source.hash, JSON.stringify(metadata)]);
        this.database.run("DELETE FROM task_inventory_rows WHERE profile_id = ? AND source_key = ? AND source_hash != ?", [source.profileId, sourceKey(source), source.hash]);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async readTaskInventoryPage(profileId: string, input: unknown, sources: LocalTaskInventorySource[]) {
    await this.inventoryReady();
    const query = TaskInventoryQuerySchema.parse(input);
    const scope = contentHash({ profileId, ...query, after: undefined, limit: undefined, sources: sources.map(source => [sourceKey(source), source.hash]) });
    const cursor = query.after ? CursorSchema.parse(JSON.parse(Buffer.from(query.after, "base64url").toString("utf8"))) : null;
    if (cursor && cursor.scope !== scope) throw new Error("Task cursor is stale or belongs to another view.");
    const selected = sources.filter(source => (!query.tasksetId || source.id === query.tasksetId) && (!query.draftId || source.draft && source.id === query.draftId));
    const keys = new Map(selected.map(source => [sourceKey(source), source]));
    if (!keys.size) return TaskInventoryPageSchema.parse({ items: [], nextCursor: null });
    const matches = [...keys.keys()];
    const search = `%${query.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = this.database.all<{ source_key: string; source_hash: string; task_id: string; ordinal: number; title: string; description: string; split: string; metadata: string }>(
      `SELECT r.source_key, r.source_hash, r.task_id, r.ordinal, r.title, r.description, r.split, s.metadata FROM task_inventory_rows r JOIN task_inventory_sources s ON s.profile_id=r.profile_id AND s.source_key=r.source_key AND s.source_hash=r.source_hash
       WHERE r.profile_id=? AND r.source_key IN (${matches.map(() => "?").join(",")})
       AND (? IS NULL OR r.split=?) AND (? IS NULL OR r.task_id=?) AND (r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.task_id LIKE ? ESCAPE '\\')
       AND (? IS NULL OR r.source_key > ? OR (r.source_key = ? AND r.ordinal > ?)) ORDER BY r.source_key, r.ordinal LIMIT ?`,
      [profileId, ...matches, query.split ?? null, query.split ?? null, query.taskId ?? null, query.taskId ?? null, search, search, search, cursor?.key ?? null, cursor?.key ?? null, cursor?.key ?? null, cursor?.ordinal ?? -1, query.limit + 1]);
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return TaskInventoryPageSchema.parse({ items: visible.map(row => {
      const source = keys.get(row.source_key)!;
      if (source.hash !== row.source_hash) throw new Error("Task inventory changed. Reload the task list.");
      return TaskInventoryItemSchema.parse({ ...JSON.parse(row.metadata), tasksetId: source.id, tasksetRevision: source.revision, tasksetHash: source.hash,
        taskId: row.task_id, ordinal: row.ordinal, title: row.title, description: row.description, split: row.split, draftId: source.draft ? source.id : null, modelId: source.modelId });
    }), nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ scope, key: last.source_key, ordinal: last.ordinal })).toString("base64url") : null });
  }

  async readTaskInventoryTask(source: LocalTaskInventorySource, taskId: string) {
    await this.inventoryReady();
    const row = this.database.get<{ payload: string }>("SELECT r.payload FROM task_inventory_rows r JOIN task_inventory_sources s ON s.profile_id=r.profile_id AND s.source_key=r.source_key AND s.source_hash=r.source_hash WHERE r.profile_id=? AND r.source_key=? AND r.source_hash=? AND r.task_id=?", [source.profileId, sourceKey(source), source.hash, taskId]);
    if (!row) throw new Error("Task not found in this collection.");
    return TaskDataRecordSchema.parse(JSON.parse(row.payload));
  }
}

function sourceKey(source: LocalTaskInventorySource) { return `${source.draft ? "draft" : "release"}:${source.id}`; }
