import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  TOOL_LEARNING_LIMITS,
  ToolEpisodeEventSchema,
  ToolLearningCapturePolicySchema,
  ToolLearningIdSchema,
  ToolLearningClientSchema,
  toolLearningContentHash,
  assertToolEpisodeCapturePolicy,
  type ToolEpisodeEvent,
  ToolLearningConsultationRequestSchema,
  type ToolLearningConsultationRequest,
} from "@openpond/evals/tool-learning";
import { z } from "zod";

export const LocalToolLearningInstallationSchema = z
  .object({
    schemaVersion: z.literal("openpond.localToolLearningInstallation.v1"),
    id: ToolLearningIdSchema,
    teamId: ToolLearningIdSchema,
    projectId: ToolLearningIdSchema,
    client: ToolLearningClientSchema,
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
      CREATE TABLE IF NOT EXISTS capture_boundaries (
        installation_id TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL,
        phase TEXT NOT NULL, payload TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(installation_id, session_id, call_id, phase)
      );
      CREATE INDEX IF NOT EXISTS capture_boundaries_expiry ON capture_boundaries(expires_at);
      CREATE TABLE IF NOT EXISTS client_observations (
        installation_id TEXT NOT NULL, event_name TEXT NOT NULL,
        observed_at TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(installation_id, event_name)
      );
      CREATE TABLE IF NOT EXISTS consultation_requests (
        installation_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        payload TEXT NOT NULL, size_bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(installation_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS consultation_requests_expiry ON consultation_requests(expires_at);
    `);
    this.expireCaptureBoundaries();
    this.db.prepare("DELETE FROM consultation_requests WHERE expires_at <= ?").run(Date.now());
  }

  close(): void {
    this.db.close();
  }

  /** Short-lived sanitized correlation, not a conversation archive. Stable
   * boundaries survive separate hook processes and lost acknowledgements. */
  captureBoundary(
    installationId: string,
    sessionId: string,
    callId: string,
    phase: "attempt" | "observation",
  ): ToolEpisodeEvent | null {
    this.expireCaptureBoundaries();
    const row = this.db
      .prepare(
        "SELECT payload FROM capture_boundaries WHERE installation_id = ? AND session_id = ? AND call_id = ? AND phase = ?",
      )
      .get(installationId, sessionId, callId, phase);
    if (!row) return null;
    const event = ToolEpisodeEventSchema.parse(JSON.parse(String(row.payload)));
    const installation = this.installation(installationId);
    if (
      !installation?.enabled ||
      event.sanitization.policyHash !== toolLearningContentHash(installation.policy)
    )
      return null;
    return event;
  }

  retainCaptureBoundary(value: unknown, now = Date.now()): ToolEpisodeEvent | null {
    const event = ToolEpisodeEventSchema.parse(value);
    if (event.eventKind !== "attempt" && event.eventKind !== "observation")
      throw new Error("tool_learning_capture_boundary_kind");
    return this.transaction(() => {
      this.expireCaptureBoundaries(now);
      const installation = this.installation(event.installationId);
      if (!installation?.enabled) return null;
      assertToolEpisodeCapturePolicy(event, installation.policy);
      const previous = this.captureBoundary(
        event.installationId,
        event.sessionId,
        event.callId,
        event.eventKind,
      );
      if (previous) return previous;
      const payload = JSON.stringify(event),
        size = Buffer.byteLength(payload);
      const total = this.retainedUsage();
      const scoped = this.retainedUsage(installation.id);
      if (
        Number(total.count) >= TOOL_LEARNING_LIMITS.queueEvents ||
        Number(scoped.count) >= installation.policy.maximumQueueEvents ||
        Number(scoped.bytes) + size > installation.policy.maximumQueueBytes ||
        Number(total.bytes) + size > TOOL_LEARNING_LIMITS.queueBytes
      ) {
        this.recordDropped(event.installationId);
        return null;
      }
      this.db
        .prepare("INSERT INTO capture_boundaries VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          event.installationId,
          event.sessionId,
          event.callId,
          event.eventKind,
          payload,
          size,
          now + installation.policy.maximumQueueAgeSeconds * 1000,
        );
      return event;
    });
  }

  recordDropped(installationId: string): void {
    this.db
      .prepare(
        "INSERT INTO counters(installation_id, dropped) VALUES (?, 1) ON CONFLICT(installation_id) DO UPDATE SET dropped = dropped + 1",
      )
      .run(installationId);
  }

  recordClientObservation(installationId: string, name: string): void {
    if (
      !["start", "resume", "compact", "turn_context", "pre_tool", "post_tool", "failure"].includes(
        name,
      )
    )
      throw new Error("tool_learning_unknown_client_observation");
    if (!this.installation(installationId)?.enabled) return;
    this.db
      .prepare(
        "INSERT INTO client_observations VALUES (?, ?, ?, 1) ON CONFLICT(installation_id, event_name) DO UPDATE SET observed_at = excluded.observed_at, count = count + 1",
      )
      .run(installationId, name, new Date().toISOString());
  }

  /** Keep bounded follow-up evidence after a failure so success sampling does
   * not discard a possible recovery. This is not a verified recovery link. */
  hasRecoveryCandidateContext(installationId: string, sessionId: string, now = Date.now()) {
    const rows = this.db
      .prepare(
        "SELECT payload FROM capture_boundaries WHERE installation_id = ? AND session_id = ? AND phase = 'observation' AND expires_at > ? ORDER BY json_extract(payload, '$.occurredAt') DESC LIMIT 33",
      )
      .all(installationId, sessionId, now) as Array<{ payload: string }>;
    return rows.slice(0, 32).some((row) => {
      const event = ToolEpisodeEventSchema.parse(JSON.parse(row.payload));
      return (
        event.eventKind === "observation" &&
        event.payload.outcome === "failed" &&
        Date.parse(event.occurredAt) >= now - 600000
      );
    });
  }

  clientObservations(installationId: string) {
    return this.db
      .prepare(
        "SELECT event_name AS event, observed_at AS observedAt, count FROM client_observations WHERE installation_id = ? ORDER BY event_name",
      )
      .all(installationId);
  }

  consultationRequest(
    installationId: string,
    operationId: string,
  ): ToolLearningConsultationRequest | null {
    this.db.prepare("DELETE FROM consultation_requests WHERE expires_at <= ?").run(Date.now());
    const row = this.db
      .prepare(
        "SELECT payload FROM consultation_requests WHERE installation_id = ? AND operation_id = ?",
      )
      .get(installationId, operationId);
    return row
      ? ToolLearningConsultationRequestSchema.parse(JSON.parse(String(row.payload)))
      : null;
  }

  consultationForCall(installationId: string, sessionId: string, callId: string) {
    this.db.prepare("DELETE FROM consultation_requests WHERE expires_at <= ?").run(Date.now());
    const row = this.db
      .prepare(
        "SELECT payload FROM consultation_requests WHERE installation_id = ? AND json_extract(payload, '$.sessionId') = ? AND json_extract(payload, '$.callId') = ? ORDER BY expires_at DESC LIMIT 1",
      )
      .get(installationId, sessionId, callId);
    return row
      ? ToolLearningConsultationRequestSchema.parse(JSON.parse(String(row.payload)))
      : null;
  }

  retainConsultationRequest(value: unknown): ToolLearningConsultationRequest {
    const request = ToolLearningConsultationRequestSchema.parse(value);
    return this.transaction(() => {
      const previous = this.consultationRequest(request.installationId, request.operationId);
      if (previous) {
        if (toolLearningContentHash(previous) !== toolLearningContentHash(request))
          throw new Error("tool_learning_consultation_identity_conflict");
        return previous;
      }
      const installation = this.installation(request.installationId);
      if (
        !installation?.enabled ||
        installation.teamId !== request.scope.teamId ||
        installation.projectId !== request.scope.projectId ||
        !installation.policy.purposes.includes("consultation")
      )
        throw new Error("tool_learning_consultation_disabled");
      const payload = JSON.stringify(request),
        bytes = Buffer.byteLength(payload);
      const total = this.retainedUsage();
      const scoped = this.retainedUsage(installation.id);
      if (
        Number(total.count) >= TOOL_LEARNING_LIMITS.queueEvents ||
        Number(scoped.count) >= installation.policy.maximumQueueEvents ||
        Number(scoped.bytes) + bytes > installation.policy.maximumQueueBytes ||
        Number(total.bytes) + bytes > TOOL_LEARNING_LIMITS.queueBytes
      )
        throw new Error("tool_learning_consultation_capacity_reached");
      this.db
        .prepare("INSERT INTO consultation_requests VALUES (?, ?, ?, ?, ?)")
        .run(
          request.installationId,
          request.operationId,
          payload,
          bytes,
          Date.now() + installation.policy.maximumQueueAgeSeconds * 1000,
        );
      return request;
    });
  }

  private retainedUsage(installationId?: string) {
    const suffix = installationId === undefined ? "" : " WHERE installation_id = ?";
    const query = `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM (SELECT installation_id, size_bytes FROM events UNION ALL SELECT installation_id, size_bytes FROM capture_boundaries UNION ALL SELECT installation_id, size_bytes FROM consultation_requests)${suffix}`;
    return installationId === undefined
      ? this.db.prepare(query).get()!
      : this.db.prepare(query).get(installationId)!;
  }

  private expireCaptureBoundaries(now = Date.now()): void {
    this.db.prepare("DELETE FROM capture_boundaries WHERE expires_at <= ?").run(now);
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
      const total = this.retainedUsage();
      const scoped = this.retainedUsage(installation.id);
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
    limit: number = TOOL_LEARNING_LIMITS.eventsPerAppend,
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
    accepted: Array<{
      eventId: string;
      contentHash: string;
      state?: "retained" | "already_retained" | "privacy_rejected";
    }>,
  ): void {
    if (accepted.length > TOOL_LEARNING_LIMITS.eventsPerAppend)
      throw new Error("tool_learning_ack_limit");
    this.transaction(() => {
      for (const event of accepted) {
        const removed = this.db
          .prepare("DELETE FROM events WHERE installation_id = ? AND id = ? AND content_hash = ?")
          .run(installationId, event.eventId, event.contentHash);
        if (event.state === "privacy_rejected" && Number(removed.changes) > 0)
          this.db
            .prepare(
              "INSERT INTO counters(installation_id, dropped) VALUES (?, ?) ON CONFLICT(installation_id) DO UPDATE SET dropped = dropped + excluded.dropped",
            )
            .run(installationId, removed.changes);
      }
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
