import { ConversationServingExecutionSchema, ConversationServingGrantSchema, type ConversationServingExecution, type ConversationServingGrant } from "../training/conversation-serving-contracts.js";
import { SqliteStoreDomain } from "./store-domain.js";

/** The serving owner retains its explicit grants and recovery intents in the
 * same durable SQLite owner as atomic Model bindings. */
export class SqliteConversationServingStore extends SqliteStoreDomain {
  private conversationTables: Promise<void> | null = null;
  private async ensureConversationTables() {
    await this.ready;
    if (!this.conversationTables) {
      const write = this.writeQueue.then(async () => {
        await this.exec("CREATE TABLE IF NOT EXISTS conversation_serving_grants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)");
        await this.exec("CREATE TABLE IF NOT EXISTS conversation_serving_executions (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL)");
      });
      this.writeQueue = write.catch(() => undefined);
      this.conversationTables = write;
    }
    await this.conversationTables;
  }
  async listConversationServingGrants(): Promise<ConversationServingGrant[]> {
    await this.ensureConversationTables(); await this.writeQueue;
    return (await this.all<{ payload: string }>("SELECT payload FROM conversation_serving_grants ORDER BY id", [])).map(row => ConversationServingGrantSchema.parse(JSON.parse(row.payload)));
  }
  async listConversationServingExecutions(grantId: string): Promise<ConversationServingExecution[]> {
    await this.ensureConversationTables(); await this.writeQueue;
    return (await this.all<{ payload: string }>("SELECT payload FROM conversation_serving_executions WHERE grant_id = ? ORDER BY id", [grantId])).map(row => ConversationServingExecutionSchema.parse(JSON.parse(row.payload)));
  }
  async saveConversationServingGrant(raw: ConversationServingGrant, expectedRevision: number) {
    const value = ConversationServingGrantSchema.parse(raw);
    await this.saveConversationServingRow("conversation_serving_grants", value.id, value.revision, value, expectedRevision);
    return value;
  }
  async saveConversationServingExecution(raw: ConversationServingExecution, expectedRevision: number) {
    const value = ConversationServingExecutionSchema.parse(raw);
    await this.saveConversationServingRow("conversation_serving_executions", value.id, value.revision, value, expectedRevision, value.grantId);
    return value;
  }
  private async saveConversationServingRow(table: "conversation_serving_grants" | "conversation_serving_executions", id: string, revision: number, payload: unknown, expectedRevision: number, grantId?: string) {
    if (revision !== expectedRevision + 1) throw new Error("Conversation serving revision is invalid.");
    await this.ensureConversationTables();
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const prior = await this.get<{ revision: number; payload: string }>(`SELECT revision, payload FROM ${table} WHERE id = ?`, [id]);
        if ((prior?.revision ?? 0) !== expectedRevision) throw new Error("Conversation serving authority changed.");
        if (prior) {
          const previous = JSON.parse(prior.payload) as Record<string, unknown>, next = payload as Record<string, unknown>;
          const immutable = table === "conversation_serving_grants" ? ["id", "ownerInstanceId", "teamId", "profileId", "projectId", "hostedModelId", "role", "roleTargetId"] : ["id", "grantId", "jobId", "artifactHash", "priorBindingId", "leaseId", "canarySeconds", "createdAt"];
          if (immutable.some(key => previous[key] !== next[key])) throw new Error("The retained serving identity cannot be replaced.");
        }
        if (table === "conversation_serving_grants") {
          const grant = ConversationServingGrantSchema.parse(payload);
          if (grant.enabled) {
            const collision = await this.get<{ id: string }>("SELECT id FROM conversation_serving_grants WHERE id != ? AND json_extract(payload, '$.enabled') = 1 AND json_extract(payload, '$.profileId') = ? AND json_extract(payload, '$.role') = ? AND json_extract(payload, '$.roleTargetId') = ? LIMIT 1", [id, grant.profileId, grant.role, grant.roleTargetId]);
            if (collision) throw new Error("This native serving target already has an enabled owner grant. Revoke it before registering another.");
          }
        }
        if (prior) await this.run(`UPDATE ${table} SET revision = ?, payload = ? WHERE id = ?`, [revision, JSON.stringify(payload), id]);
        else if (grantId) await this.run(`INSERT INTO ${table} (id, grant_id, revision, payload) VALUES (?, ?, ?, ?)`, [id, grantId, revision, JSON.stringify(payload)]);
        else await this.run(`INSERT INTO ${table} (id, revision, payload) VALUES (?, ?, ?)`, [id, revision, JSON.stringify(payload)]);
        await this.exec("COMMIT");
      } catch (error) { await this.exec("ROLLBACK").catch(() => undefined); throw error; }
    });
    this.writeQueue = write.catch(() => undefined); await write;
  }
}
