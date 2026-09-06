import { LearningSourceCredentialSchema, type LearningSourceCredential } from "openpond-sdk/learning";
import { SqliteStoreCore } from "./store-core.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { LearningDomainError } from "@openpond/evals/learning";

type CredentialRow = { payload: string };

/** Credential secrets are never persisted. All access uses the owning scope. */
export class SqliteLearningCredentialStore extends SqliteStoreCore {
  private async credentialTransaction<T>(callback: (database: OpenPondSqliteConnection) => T): Promise<T> {
    await this.ready;
    const operation = this.writeQueue.then(() => {
      const database = this.database;
      database.exec("BEGIN IMMEDIATE");
      try { const value = callback(database); database.exec("COMMIT"); return value; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async createLearningSourceCredential(record: LearningSourceCredential, keyHash: string, requestHash: string): Promise<LearningSourceCredential> {
    const credential = LearningSourceCredentialSchema.parse(record);
    return this.credentialTransaction((database) => {
      const previous = database.get<CredentialRow & { request_hash: string }>("SELECT payload, request_hash FROM learning_source_credentials WHERE id = ?", [credential.id]);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new LearningDomainError("learning_credential_operation_conflict", 409);
        return LearningSourceCredentialSchema.parse(JSON.parse(previous.payload));
      }
      if (database.get("SELECT id FROM learning_source_credentials WHERE key_hash = ?", [keyHash])) throw new LearningDomainError("learning_credential_secret_reused", 409);
      database.run("INSERT INTO learning_source_credentials (id, scope, source_id, key_hash, request_hash, payload) VALUES (?, ?, ?, ?, ?, ?)",
        [credential.id, credential.scope, credential.sourceId, keyHash, requestHash, JSON.stringify(credential)]);
      return credential;
    });
  }

  async findLearningSourceCredential(keyHash: string): Promise<LearningSourceCredential | null> {
    await this.ready;
    await this.writeQueue;
    const row = this.database.get<CredentialRow>("SELECT payload FROM learning_source_credentials WHERE key_hash = ?", [keyHash]);
    return row ? LearningSourceCredentialSchema.parse(JSON.parse(row.payload)) : null;
  }

  async listLearningSourceCredentials(scope: string, sourceId: string, limit: number, afterId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("learning_credential_page_invalid");
    await this.ready;
    await this.writeQueue;
    const rows = this.database.all<CredentialRow>(
      "SELECT payload FROM learning_source_credentials WHERE scope = ? AND source_id = ? AND id > ? ORDER BY id LIMIT ?",
      [scope, sourceId, afterId ?? "", limit + 1],
    );
    const items = rows.slice(0, limit).map((row) => LearningSourceCredentialSchema.parse(JSON.parse(row.payload)));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async revokeLearningSourceCredential(scope: string, sourceId: string, id: string, revokedAt: string) {
    return this.credentialTransaction((database) => {
      const row = database.get<CredentialRow>("SELECT payload FROM learning_source_credentials WHERE scope = ? AND source_id = ? AND id = ?", [scope, sourceId, id]);
      if (!row) return null;
      const current = LearningSourceCredentialSchema.parse(JSON.parse(row.payload));
      if (current.revokedAt !== null) return current;
      const next = LearningSourceCredentialSchema.parse({ ...current, revokedAt });
      database.run("UPDATE learning_source_credentials SET payload = ? WHERE scope = ? AND source_id = ? AND id = ?", [JSON.stringify(next), scope, sourceId, id]);
      return next;
    });
  }
}
