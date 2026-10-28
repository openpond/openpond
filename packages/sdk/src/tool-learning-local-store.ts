import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  TOOL_LEARNING_LIMITS,
  ToolEpisodeEventSchema,
  ToolLearningCapturePolicySchema,
  ToolLearningIdSchema,
  toolLearningContentHash,
  assertToolEpisodeCapturePolicy,
  type ToolEpisodeEvent,
} from "@openpond/evals/tool-learning";
import { z } from "zod";

export const LocalToolLearningInstallationSchema = z
  .object({
    schemaVersion: z.literal("openpond.localToolLearningInstallation.v1"),
    id: ToolLearningIdSchema,
    teamId: ToolLearningIdSchema,
    projectId: ToolLearningIdSchema,
    client: z.enum(["claude_code", "openpond"]),
    workspaceRoot: z.string().min(1).max(4000),
    enabled: z.boolean(),
    policy: ToolLearningCapturePolicySchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LocalToolLearningInstallation = z.infer<typeof LocalToolLearningInstallationSchema>;

/** Local-only bounded delivery ledger shared by the CLI hooks and native app.
 * The ledger has no authentication, API, training, or tool-execution authority.
 */
export class ToolLearningLocalStore {
  private readonly db: DatabaseSync;

  constructor(home: string) {
    const directory = join(home, "tool-learning");
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
      throw new Error("tool_learning_directory_symlink_forbidden");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const filename = join(directory, "queue.sqlite");
    if (existsSync(filename)) {
      if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
        throw new Error("tool_learning_queue_file_invalid");
    } else {
      closeSync(openSync(filename, "wx", 0o600));
    }
    chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL, content_hash TEXT NOT NULL,
        payload TEXT NOT NULL, size_bytes INTEGER NOT NULL, received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_installation ON events(installation_id, received_at, id);
      CREATE INDEX IF NOT EXISTS events_episode ON events(installation_id, episode_id);
      CREATE INDEX IF NOT EXISTS events_policy ON events(installation_id, policy_hash, received_at, id);
      CREATE TABLE IF NOT EXISTS counters (
        installation_id TEXT PRIMARY KEY, dropped INTEGER NOT NULL DEFAULT 0, expired INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  installation(id: string): LocalToolLearningInstallation | null {
    const row = this.db.prepare("SELECT payload FROM installations WHERE id = ?").get(id);
    return row ? LocalToolLearningInstallationSchema.parse(JSON.parse(String(row.payload))) : null;
  }

  installations(): LocalToolLearningInstallation[] {
    return this.db
      .prepare("SELECT payload FROM installations ORDER BY id")
      .all()
      .map((row) => LocalToolLearningInstallationSchema.parse(JSON.parse(String(row.payload))));
  }

  configure(value: unknown): LocalToolLearningInstallation {
    const installation = LocalToolLearningInstallationSchema.parse(value);
    this.transaction(() => {
      const previous = this.installation(installation.id);
      if (
        previous &&
        ["teamId", "projectId", "client", "workspaceRoot"].some(
          (key) =>
            previous[key as keyof LocalToolLearningInstallation] !==
            installation[key as keyof LocalToolLearningInstallation],
        )
      )
        throw new Error("tool_learning_installation_scope_immutable");
      if (
        previous &&
        (installation.policy.revision < previous.policy.revision ||
          (installation.policy.revision === previous.policy.revision &&
            toolLearningContentHash(installation.policy) !==
              toolLearningContentHash(previous.policy)))
      )
        throw new Error("tool_learning_capture_policy_revision_conflict");
      this.db
        .prepare(
          "INSERT INTO installations VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(installation.id, JSON.stringify(installation));
    });
    return installation;
  }

  append(
    value: unknown,
    now = Date.now(),
  ): "retained" | "already_retained" | "disabled" | "expired" | "queue_full" {
    const event = ToolEpisodeEventSchema.parse(value);
    const payload = JSON.stringify(event),
      bytes = Buffer.byteLength(payload);
    return this.transaction(() => {
      const installation = this.installation(event.installationId);
      if (!installation?.enabled) return "disabled";
      const policy = installation.policy;
      if (!policy.purposes.includes("capture")) return "disabled";
      assertToolEpisodeCapturePolicy(event, policy);
      const previous = this.db
        .prepare("SELECT content_hash, installation_id FROM events WHERE id = ?")
        .get(event.eventId);
      if (previous) {
        if (
          previous.content_hash !== event.contentHash ||
          previous.installation_id !== event.installationId
        )
          throw new Error("tool_learning_event_identity_conflict");
        return "already_retained";
      }
      this.db
        .prepare("INSERT INTO counters(installation_id) VALUES (?) ON CONFLICT DO NOTHING")
        .run(installation.id);
      const cutoff = now - policy.maximumQueueAgeSeconds * 1000;
      const expired = this.db
        .prepare("DELETE FROM events WHERE installation_id = ? AND received_at < ?")
        .run(installation.id, cutoff).changes;
      this.db
        .prepare("UPDATE counters SET expired = expired + ? WHERE installation_id = ?")
        .run(expired, installation.id);
      if (Date.parse(event.occurredAt) < cutoff || Date.parse(event.occurredAt) > now + 300_000) {
        this.db
          .prepare("UPDATE counters SET expired = expired + 1 WHERE installation_id = ?")
          .run(installation.id);
        return "expired";
      }
      // A home-wide ceiling also bounds many separately configured installations.
      const total = this.db
        .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM events")
        .get()!;
      const scoped = this.db
        .prepare(
          "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM events WHERE installation_id = ?",
        )
        .get(installation.id)!;
      const episode = this.db
        .prepare(
          "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM events WHERE installation_id = ? AND episode_id = ?",
        )
        .get(installation.id, event.episodeId)!;
      if (
        Number(total.count) >= TOOL_LEARNING_LIMITS.queueEvents ||
        Number(total.bytes) + bytes > TOOL_LEARNING_LIMITS.queueBytes ||
        Number(scoped.count) >= policy.maximumQueueEvents ||
        Number(scoped.bytes) + bytes > policy.maximumQueueBytes ||
        Number(episode.count) >= policy.maximumEpisodeEvents ||
        Number(episode.bytes) + bytes > policy.maximumEpisodeBytes
      ) {
        this.db
          .prepare("UPDATE counters SET dropped = dropped + 1 WHERE installation_id = ?")
          .run(installation.id);
        return "queue_full";
      }
      this.db
        .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          event.eventId,
          installation.id,
          event.episodeId,
          event.sanitization.policyHash,
          event.contentHash,
          payload,
          bytes,
          now,
        );
      return "retained";
    });
  }

  pending(
    installationId: string,
    limit = TOOL_LEARNING_LIMITS.eventsPerAppend,
  ): ToolEpisodeEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > TOOL_LEARNING_LIMITS.eventsPerAppend)
      throw new Error("tool_learning_queue_page_limit");
    this.expire(installationId);
    const installation = this.installation(installationId);
    if (!installation?.enabled || !installation.policy.purposes.includes("capture")) return [];
    return this.db
      .prepare(
        "SELECT payload FROM events WHERE installation_id = ? AND policy_hash = ? ORDER BY received_at, id LIMIT ?",
      )
      .all(installationId, toolLearningContentHash(installation.policy), limit)
      .map((row) => ToolEpisodeEventSchema.parse(JSON.parse(String(row.payload))));
  }

  acknowledge(
    installationId: string,
    accepted: Array<{ eventId: string; contentHash: string }>,
  ): void {
    if (accepted.length > TOOL_LEARNING_LIMITS.eventsPerAppend)
      throw new Error("tool_learning_ack_limit");
    this.transaction(() => {
      for (const event of accepted)
        this.db
          .prepare("DELETE FROM events WHERE installation_id = ? AND id = ? AND content_hash = ?")
          .run(installationId, event.eventId, event.contentHash);
    });
  }

  status(installationId: string) {
    this.expire(installationId);
    const installation = this.installation(installationId);
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS events, COALESCE(SUM(size_bytes), 0) AS bytes FROM events WHERE installation_id = ?",
      )
      .get(installationId)!;
    const counter = this.db
      .prepare("SELECT dropped, expired FROM counters WHERE installation_id = ?")
      .get(installationId);
    const deliverable =
      installation?.enabled && installation.policy.purposes.includes("capture")
        ? Number(
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM events WHERE installation_id = ? AND policy_hash = ?",
              )
              .get(installationId, toolLearningContentHash(installation.policy))!.count,
          )
        : 0;
    return {
      pendingEvents: Number(pending.events),
      pendingBytes: Number(pending.bytes),
      droppedEvents: Number(counter?.dropped ?? 0),
      expiredEvents: Number(counter?.expired ?? 0),
      blockedByPolicyEvents: Number(pending.events) - deliverable,
    };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private expire(installationId: string): void {
    const installation = this.installation(installationId);
    if (!installation) return;
    this.transaction(() => {
      const expired = this.db
        .prepare("DELETE FROM events WHERE installation_id = ? AND received_at < ?")
        .run(
          installationId,
          Date.now() - installation.policy.maximumQueueAgeSeconds * 1000,
        ).changes;
      this.db
        .prepare(
          "INSERT INTO counters(installation_id, expired) VALUES (?, ?) ON CONFLICT(installation_id) DO UPDATE SET expired = expired + excluded.expired",
        )
        .run(installationId, expired);
    });
  }
}
