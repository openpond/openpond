import {
  LearningConflictError,
  learningResourceSchemas,
  type LearningOperationReceipt,
  type LearningRepository,
  type LearningResourceFor,
  type LearningResourceKind,
  type LearningTransaction,
} from "@openpond/evals/learning";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { SqliteLearningCredentialStore } from "./store-learning-credentials.js";

type RevisionRow = { revision: number };
type PayloadRow = { payload: string };

export class SqliteLearningStore extends SqliteLearningCredentialStore {
  async listLearningScopes(): Promise<string[]> {
    await this.ready;
    await this.writeQueue;
    return (await this.all<{ scope: string }>("SELECT DISTINCT scope FROM learning_resources ORDER BY scope", [])).map((row) => row.scope);
  }

  learningRepository(): LearningRepository {
    return {
      transaction: async <T>(scope: string, callback: (transaction: LearningTransaction) => Promise<T>): Promise<T> => {
        if (!scope.trim()) throw new Error("learning_scope_required");
        await this.ready;
        const operation = this.writeQueue.then(async () => {
          const db = this.db;
          if (!db) throw new Error("learning_store_closed");
          db.exec("BEGIN IMMEDIATE");
          let open = true;
          const transaction = createLearningTransaction(db, scope, () => {
            if (!open) throw new Error("learning_transaction_closed");
          });
          try {
            const result = await callback(transaction);
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          } finally {
            open = false;
          }
        });
        this.writeQueue = operation.then(() => undefined, () => undefined);
        return operation;
      },
    };
  }
}

function createLearningTransaction(db: OpenPondSqliteConnection, scope: string, assertOpen: () => void): LearningTransaction {
  const parse = <K extends LearningResourceKind>(kind: K, row: PayloadRow): LearningResourceFor<K> =>
    learningResourceSchemas[kind].parse(JSON.parse(row.payload)) as LearningResourceFor<K>;
  return {
    async get(kind, id, revision) {
      assertOpen();
      const row = revision === undefined
        ? db.get<PayloadRow>(`SELECT history.payload FROM learning_resources current
            JOIN learning_revisions history USING (scope, kind, id, revision)
            WHERE current.scope = ? AND current.kind = ? AND current.id = ?`, [scope, kind, id])
        : db.get<PayloadRow>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [scope, kind, id, revision]);
      return row ? parse(kind, row) : null;
    },
    async put(kind, value, expectedRevision, index) {
      assertOpen();
      const resource = learningResourceSchemas[kind].parse(value);
      const current = db.get<RevisionRow>("SELECT revision FROM learning_resources WHERE scope = ? AND kind = ? AND id = ?", [scope, kind, resource.id]);
      if ((current?.revision ?? 0) !== expectedRevision) throw new LearningConflictError(kind, resource.id, expectedRevision, current?.revision ?? 0);
      if (resource.revision !== expectedRevision + 1) throw new Error("learning_resource_revision_invalid");
      db.run("INSERT INTO learning_revisions (scope, kind, id, revision, payload) VALUES (?, ?, ?, ?, ?)", [scope, kind, resource.id, resource.revision, JSON.stringify(resource)]);
      db.run(`INSERT INTO learning_resources (scope, kind, id, revision, parent_id, status) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope, kind, id) DO UPDATE SET revision = excluded.revision, parent_id = excluded.parent_id, status = excluded.status`,
      [scope, kind, resource.id, resource.revision, index?.parentId ?? null, index?.status ?? null]);
    },
    async list(kind, query) {
      assertOpen();
      const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
      if (!Number.isFinite(limit)) throw new Error("learning_query_limit_invalid");
      const filters = ["current.scope = ?", "current.kind = ?"];
      const params: unknown[] = [scope, kind];
      for (const [column, value] of [["parent_id", query.parentId], ["status", query.status]] as const) {
        if (value !== undefined) { filters.push(`current.${column} = ?`); params.push(value); }
      }
      if (query.afterId !== undefined) { filters.push("current.id > ?"); params.push(query.afterId); }
      const rows = db.all<PayloadRow>(`SELECT history.payload FROM learning_resources current
        JOIN learning_revisions history USING (scope, kind, id, revision)
        WHERE ${filters.join(" AND ")} ORDER BY current.id LIMIT ?`, [...params, limit + 1]);
      const items = rows.slice(0, limit).map((row) => parse(kind, row));
      return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
    },
    async operation(id) {
      assertOpen();
      const row = db.get<PayloadRow>("SELECT payload FROM learning_operations WHERE scope = ? AND id = ?", [scope, id]);
      return row ? JSON.parse(row.payload) as LearningOperationReceipt : null;
    },
    async saveOperation(id, receipt) {
      assertOpen();
      db.run("INSERT INTO learning_operations (scope, id, payload) VALUES (?, ?, ?)", [scope, id, JSON.stringify(receipt)]);
    },
    async familySplit(namespace, kind, key) {
      assertOpen();
      return db.get<{ split: string }>("SELECT split FROM learning_family_splits WHERE scope = ? AND namespace = ? AND kind = ? AND key = ?", [scope, namespace, kind, key])?.split ?? null;
    },
    async reserveFamilySplit(namespace, kind, key, split) {
      assertOpen();
      const current = db.get<{ split: string }>("SELECT split FROM learning_family_splits WHERE scope = ? AND namespace = ? AND kind = ? AND key = ?", [scope, namespace, kind, key]);
      if (current && current.split !== split) throw new Error("task_family_split_conflict");
      if (!current) db.run("INSERT INTO learning_family_splits (scope, namespace, kind, key, split) VALUES (?, ?, ?, ?, ?)", [scope, namespace, kind, key, split]);
    },
  };
}
