import type {
  BaselineReport,
  GradeResult,
  GraderAuditReport,
  ModelArtifactLineage,
  RuntimeEvent,
  Session,
  TaskAttemptArtifact,
  TaskAttemptResult,
  TaskCandidate,
  TaskCandidateStatus,
  TaskCreationSnapshot,
  TaskMinerConfig,
  TaskMinerRun,
  Taskset,
  TasksetReadinessReport,
  TrainingApproval,
  TrainingArtifact,
  TrainingBundleManifest,
  TrainingChatSearchResult,
  TrainingJob,
  TrainingJobEvent,
  TrainingPlan,
  TrainingSourceRef,
  Turn,
} from "@openpond/contracts";
import {
  BaselineReportSchema,
  GradeResultSchema,
  GraderAuditReportSchema,
  ModelArtifactLineageSchema,
  TaskAttemptArtifactSchema,
  TaskAttemptResultSchema,
  TaskCandidateSchema,
  TaskCreationSnapshotSchema,
  TaskCreationTranscriptSchema,
  TaskDesignProposalSchema,
  TaskMinerConfigSchema,
  TaskMinerRunSchema,
  TasksetReadinessReportSchema,
  TasksetSchema,
  TrainingApprovalSchema,
  TrainingArtifactSchema,
  TrainingBundleManifestSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
  TrainingPlanSchema,
  TrainingSourceRefSchema,
} from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { now } from "../utils.js";
import { SqliteStoreCore } from "./store-core.js";
import { normalizeSessionPayload } from "./store-persistence.js";

export type TrainingChatSearchDocument = {
  sessionId: string;
  source: "openpond" | "codex";
  signature: string;
  title: string;
  body: string;
  updatedAt: string;
  eligible: boolean;
  bodyIndexed: boolean;
};

type TrainingChatSearchDocumentRow = {
  session_id: string;
  signature: string;
};

type TrainingChatSearchResultRow = {
  session_id: string;
  title: string;
  updated_at: string;
  snippet: string | null;
};

type TrainingChatSearchEvidenceRow = {
  session_id: string;
  payload: string;
};


export class SqliteTrainingStore extends SqliteStoreCore {
  async trainingChatSearchSignatures(source: TrainingChatSearchDocument["source"]): Promise<Map<string, string>> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<TrainingChatSearchDocumentRow>(
      "SELECT session_id, signature FROM training_chat_search_documents WHERE source = ?",
      [source],
    );
    return new Map(rows.map((row) => [row.session_id, row.signature]));
  }

  async openPondTrainingChatSearchEvidence(candidateIdsInput: string[]): Promise<Array<{ session: Session; body: string }>> {
    await this.ready;
    await this.writeQueue;
    const candidateIds = [...new Set(candidateIdsInput)].slice(0, 500);
    if (!candidateIds.length) return [];
    const placeholders = candidateIds.map(() => "?").join(", ");
    const [sessionRows, turnRows, eventRows] = await Promise.all([
      this.all<PayloadRow>(
        `SELECT payload FROM projection_session_shells WHERE id IN (${placeholders})`,
        candidateIds,
      ),
      this.all<TrainingChatSearchEvidenceRow>(
        `SELECT session_id, payload FROM turns WHERE session_id IN (${placeholders}) ORDER BY sort_index ASC`,
        candidateIds,
      ),
      this.all<TrainingChatSearchEvidenceRow>(
        `SELECT session_id, payload FROM events
         WHERE name = 'assistant.delta' AND session_id IN (${placeholders})
         ORDER BY sequence ASC`,
        candidateIds,
      ),
    ]);
    const textBySession = new Map<string, string[]>();
    for (const row of turnRows) {
      const turn = JSON.parse(row.payload) as Turn;
      if (turn.prompt.trim()) appendTrainingChatSearchText(textBySession, row.session_id, turn.prompt);
    }
    for (const row of eventRows) {
      const event = JSON.parse(row.payload) as RuntimeEvent;
      if (event.output?.trim()) appendTrainingChatSearchText(textBySession, row.session_id, event.output);
    }
    return sessionRows.map((row) => {
      const session = normalizeSessionPayload(JSON.parse(row.payload));
      return { session, body: textBySession.get(session.id)?.join("\n") ?? "" };
    });
  }

  async syncTrainingChatSearchDocuments(
    source: TrainingChatSearchDocument["source"],
    documents: TrainingChatSearchDocument[],
  ): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const existingRows = await this.all<TrainingChatSearchDocumentRow>(
        "SELECT session_id, signature FROM training_chat_search_documents WHERE source = ?",
        [source],
      );
      const existing = new Map(existingRows.map((row) => [row.session_id, row.signature]));
      const incomingIds = new Set(documents.map((document) => document.sessionId));
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const sessionId of existing.keys()) {
          if (incomingIds.has(sessionId)) continue;
          await this.run("DELETE FROM training_chat_search_fts WHERE session_id = ?", [sessionId]);
          await this.run("DELETE FROM training_chat_search_documents WHERE session_id = ?", [sessionId]);
        }
        for (const document of documents) {
          if (existing.get(document.sessionId) === document.signature) continue;
          await this.run("DELETE FROM training_chat_search_fts WHERE session_id = ?", [document.sessionId]);
          await this.run(
            `INSERT INTO training_chat_search_documents (session_id, source, signature, title, updated_at, eligible, body_indexed)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               source = excluded.source,
               signature = excluded.signature,
               title = excluded.title,
               updated_at = excluded.updated_at,
               eligible = excluded.eligible,
               body_indexed = excluded.body_indexed`,
            [document.sessionId, document.source, document.signature, document.title, document.updatedAt, document.eligible ? 1 : 0, document.bodyIndexed ? 1 : 0],
          );
          await this.run(
            "INSERT INTO training_chat_search_fts (session_id, title, body) VALUES (?, ?, ?)",
            [document.sessionId, document.title, document.body],
          );
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async upsertTrainingChatSearchDocument(document: TrainingChatSearchDocument): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run("DELETE FROM training_chat_search_fts WHERE session_id = ?", [document.sessionId]);
        await this.run(
          `INSERT INTO training_chat_search_documents (session_id, source, signature, title, updated_at, eligible, body_indexed)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             source = excluded.source,
             signature = excluded.signature,
             title = excluded.title,
             updated_at = excluded.updated_at,
             eligible = excluded.eligible,
             body_indexed = excluded.body_indexed`,
          [document.sessionId, document.source, document.signature, document.title, document.updatedAt, document.eligible ? 1 : 0, document.bodyIndexed ? 1 : 0],
        );
        await this.run(
          "INSERT INTO training_chat_search_fts (session_id, title, body) VALUES (?, ?, ?)",
          [document.sessionId, document.title, document.body],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async searchTrainingChats(input: { query: string; offset: number; limit: number; candidateIds: string[] }): Promise<TrainingChatSearchResult> {
    await this.ready;
    await this.writeQueue;
    const query = input.query.trim();
    const offset = Math.max(0, Math.trunc(input.offset));
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const candidateIds = [...new Set(input.candidateIds)].slice(0, 500);
    if (!candidateIds.length) return trainingChatSearchResult(query, offset, limit, 0, [], 0, 0);
    const candidatePlaceholders = candidateIds.map(() => "?").join(", ");
    const progress = await this.get<{ indexed: number; total: number }>(
      `SELECT SUM(CASE WHEN body_indexed = 1 THEN 1 ELSE 0 END) AS indexed, COUNT(*) AS total
       FROM training_chat_search_documents
       WHERE eligible = 1 AND session_id IN (${candidatePlaceholders})`,
      candidateIds,
    );
    const indexedChats = progress?.indexed ?? 0;
    const totalChats = progress?.total ?? 0;
    if (!query) {
      const total = await this.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM training_chat_search_documents
         WHERE eligible = 1 AND session_id IN (${candidatePlaceholders})`,
        candidateIds,
      );
      const rows = await this.all<TrainingChatSearchResultRow>(
        `SELECT session_id, title, updated_at, NULL AS snippet
         FROM training_chat_search_documents
         WHERE eligible = 1 AND session_id IN (${candidatePlaceholders})
         ORDER BY updated_at DESC, session_id ASC
         LIMIT ? OFFSET ?`,
        [...candidateIds, limit, offset],
      );
      return trainingChatSearchResult(query, offset, limit, total?.count ?? 0, rows, indexedChats, totalChats);
    }
    const match = trainingChatFtsQuery(query);
    if (!match) return trainingChatSearchResult(query, offset, limit, 0, [], indexedChats, totalChats);
    const total = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM training_chat_search_fts
       JOIN training_chat_search_documents AS documents
         ON documents.session_id = training_chat_search_fts.session_id
       WHERE training_chat_search_fts MATCH ? AND documents.eligible = 1
         AND documents.session_id IN (${candidatePlaceholders})`,
      [match, ...candidateIds],
    );
    const rows = await this.all<TrainingChatSearchResultRow>(
      `SELECT documents.session_id, documents.title, documents.updated_at,
              snippet(training_chat_search_fts, 2, '', '', ' … ', 22) AS snippet
       FROM training_chat_search_fts
       JOIN training_chat_search_documents AS documents
         ON documents.session_id = training_chat_search_fts.session_id
       WHERE training_chat_search_fts MATCH ? AND documents.eligible = 1
         AND documents.session_id IN (${candidatePlaceholders})
       ORDER BY bm25(training_chat_search_fts, 0.0, 8.0, 1.0), documents.updated_at DESC
       LIMIT ? OFFSET ?`,
      [match, ...candidateIds, limit, offset],
    );
    return trainingChatSearchResult(query, offset, limit, total?.count ?? 0, rows, indexedChats, totalChats);
  }

  async listTrainingSources(profileId: string): Promise<TrainingSourceRef[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>("SELECT payload FROM training_sources WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]);
    return rows.map((row) => TrainingSourceRefSchema.parse(JSON.parse(row.payload)));
  }

  async getTrainingSource(id: string): Promise<TrainingSourceRef | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM training_sources WHERE id = ?", [id]);
    return row ? TrainingSourceRefSchema.parse(JSON.parse(row.payload)) : null;
  }

  async upsertTrainingSource(sourceInput: TrainingSourceRef): Promise<TrainingSourceRef> {
    const source = TrainingSourceRefSchema.parse(sourceInput);
    await this.ready;
    const timestamp = now();
    const write = this.writeQueue.then(() => this.run(
      `INSERT INTO training_sources (id, profile_id, session_id, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, session_id = excluded.session_id, payload = excluded.payload, updated_at = excluded.updated_at`,
      [source.id, source.profileId, source.sessionId, JSON.stringify(source), timestamp, timestamp],
    ));
    this.writeQueue = write.catch(() => undefined);
    await write;
    return source;
  }

  async deleteTrainingSource(id: string): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run("DELETE FROM training_sources WHERE id = ?", [id]));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async listTaskCreationSnapshots(profileId: string): Promise<TaskCreationSnapshot[]> {
    return this.listParsedPayloads("SELECT payload FROM task_creation_snapshots WHERE profile_id = ? ORDER BY updated_at DESC", [profileId], TaskCreationSnapshotSchema.parse);
  }

  async getTaskCreationSnapshot(id: string): Promise<TaskCreationSnapshot | null> {
    return this.getParsedPayload("SELECT payload FROM task_creation_snapshots WHERE id = ?", [id], TaskCreationSnapshotSchema.parse);
  }

  async upsertTaskCreationSnapshot(snapshotInput: TaskCreationSnapshot): Promise<TaskCreationSnapshot> {
    const snapshot = TaskCreationSnapshotSchema.parse(snapshotInput);
    const transcript = TaskCreationTranscriptSchema.parse({ schemaVersion: "openpond.taskCreationTranscript.v1", creationId: snapshot.id, profileId: snapshot.request.profileId, messages: snapshot.transcript, updatedAt: snapshot.updatedAt });
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run(`INSERT INTO task_creation_snapshots (id, profile_id, state, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`, [snapshot.id, snapshot.request.profileId, snapshot.state, JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt]);
        await this.run(`INSERT INTO task_creation_transcripts (creation_id, profile_id, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(creation_id) DO UPDATE SET profile_id = excluded.profile_id, payload = excluded.payload, updated_at = excluded.updated_at`, [snapshot.id, snapshot.request.profileId, JSON.stringify(transcript), snapshot.updatedAt]);
        if (snapshot.proposal) await this.run(`INSERT INTO task_design_proposals (creation_id, proposal_id, profile_id, state, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(creation_id) DO UPDATE SET proposal_id = excluded.proposal_id, profile_id = excluded.profile_id, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`, [snapshot.id, snapshot.proposal.id, snapshot.request.profileId, snapshot.state, JSON.stringify(snapshot.proposal), snapshot.updatedAt]);
        else await this.run("DELETE FROM task_design_proposals WHERE creation_id = ?", [snapshot.id]);
        await this.exec("COMMIT");
      } catch (error) { await this.exec("ROLLBACK").catch(() => undefined); throw error; }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return snapshot;
  }

  async getTaskCreationTranscript(creationId: string) {
    return this.getParsedPayload("SELECT payload FROM task_creation_transcripts WHERE creation_id = ?", [creationId], TaskCreationTranscriptSchema.parse);
  }

  async getTaskDesignProposal(creationId: string) {
    return this.getParsedPayload("SELECT payload FROM task_design_proposals WHERE creation_id = ?", [creationId], TaskDesignProposalSchema.parse);
  }

  async listTasksets(profileId: string): Promise<Taskset[]> {
    return this.listParsedPayloads("SELECT payload FROM tasksets WHERE profile_id = ? ORDER BY updated_at DESC", [profileId], TasksetSchema.parse);
  }

  async getTaskset(id: string): Promise<Taskset | null> {
    return this.getParsedPayload("SELECT payload FROM tasksets WHERE id = ?", [id], TasksetSchema.parse);
  }

  async upsertTaskset(tasksetInput: Taskset): Promise<Taskset> {
    const taskset = TasksetSchema.parse(tasksetInput);
    await this.upsertPayload(
      `INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [taskset.id, taskset.profileId, taskset.status, JSON.stringify(taskset), taskset.createdAt, taskset.updatedAt],
    );
    return taskset;
  }

  async deleteTasksetData(id: string): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run("DELETE FROM grade_results WHERE attempt_id IN (SELECT id FROM task_attempts WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM task_attempt_artifacts WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM task_attempts WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM baseline_reports WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM grader_audit_reports WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM readiness_reports WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM training_artifacts WHERE job_id IN (SELECT id FROM training_jobs WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?))", [id]);
        await this.run("DELETE FROM training_job_events WHERE job_id IN (SELECT id FROM training_jobs WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?))", [id]);
        await this.run("DELETE FROM training_jobs WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM training_approvals WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM training_bundles WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM model_artifact_lineage WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM training_plans WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM task_design_proposals WHERE creation_id IN (SELECT id FROM task_creation_snapshots WHERE json_extract(payload, '$.materializedTasksetId') = ?)", [id]);
        await this.run("DELETE FROM task_creation_transcripts WHERE creation_id IN (SELECT id FROM task_creation_snapshots WHERE json_extract(payload, '$.materializedTasksetId') = ?)", [id]);
        await this.run("DELETE FROM task_creation_snapshots WHERE json_extract(payload, '$.materializedTasksetId') = ?", [id]);
        await this.run("DELETE FROM tasksets WHERE id = ?", [id]);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async listTaskCandidates(profileId: string, status?: TaskCandidateStatus | "all"): Promise<TaskCandidate[]> {
    const sql = status && status !== "all"
      ? "SELECT payload FROM task_candidates WHERE profile_id = ? AND status = ? ORDER BY updated_at DESC"
      : "SELECT payload FROM task_candidates WHERE profile_id = ? ORDER BY updated_at DESC";
    return this.listParsedPayloads(sql, status && status !== "all" ? [profileId, status] : [profileId], TaskCandidateSchema.parse);
  }

  async getTaskCandidate(id: string): Promise<TaskCandidate | null> {
    return this.getParsedPayload("SELECT payload FROM task_candidates WHERE id = ?", [id], TaskCandidateSchema.parse);
  }

  async findTaskCandidateByFingerprint(profileId: string, fingerprint: string): Promise<TaskCandidate | null> {
    return this.getParsedPayload("SELECT payload FROM task_candidates WHERE profile_id = ? AND fingerprint = ?", [profileId, fingerprint], TaskCandidateSchema.parse);
  }

  async upsertTaskCandidate(candidateInput: TaskCandidate): Promise<TaskCandidate> {
    const candidate = TaskCandidateSchema.parse(candidateInput);
    await this.upsertPayload(
      `INSERT INTO task_candidates (id, profile_id, status, fingerprint, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, status = excluded.status, fingerprint = excluded.fingerprint, payload = excluded.payload, updated_at = excluded.updated_at`,
      [candidate.id, candidate.profileId, candidate.status, candidate.fingerprint, JSON.stringify(candidate), candidate.createdAt, candidate.updatedAt],
    );
    return candidate;
  }

  async saveTaskAttempt(attemptInput: TaskAttemptResult): Promise<TaskAttemptResult> {
    const attempt = TaskAttemptResultSchema.parse(attemptInput);
    await this.upsertPayload(
      `INSERT INTO task_attempts (id, taskset_id, split, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, split = excluded.split, payload = excluded.payload`,
      [attempt.id, attempt.tasksetId, attempt.split, JSON.stringify(attempt), attempt.completedAt],
    );
    return attempt;
  }

  async listTaskAttempts(tasksetId: string): Promise<TaskAttemptResult[]> {
    return this.listParsedPayloads("SELECT payload FROM task_attempts WHERE taskset_id = ? ORDER BY created_at ASC", [tasksetId], TaskAttemptResultSchema.parse);
  }

  async saveTaskAttemptArtifact(artifactInput: TaskAttemptArtifact): Promise<TaskAttemptArtifact> {
    const artifact = TaskAttemptArtifactSchema.parse(artifactInput);
    await this.upsertPayload(`INSERT INTO task_attempt_artifacts (id, taskset_id, attempt_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, attempt_id = excluded.attempt_id, kind = excluded.kind, payload = excluded.payload`, [artifact.id, artifact.tasksetId, artifact.attemptId, artifact.kind, JSON.stringify(artifact), artifact.createdAt]);
    return artifact;
  }

  async listTaskAttemptArtifacts(input: { tasksetId?: string; attemptId?: string }): Promise<TaskAttemptArtifact[]> {
    if (input.attemptId) return this.listParsedPayloads("SELECT payload FROM task_attempt_artifacts WHERE attempt_id = ? ORDER BY created_at", [input.attemptId], TaskAttemptArtifactSchema.parse);
    if (input.tasksetId) return this.listParsedPayloads("SELECT payload FROM task_attempt_artifacts WHERE taskset_id = ? ORDER BY created_at", [input.tasksetId], TaskAttemptArtifactSchema.parse);
    return [];
  }

  async saveGradeResult(resultInput: GradeResult): Promise<GradeResult> {
    const result = GradeResultSchema.parse(resultInput);
    await this.upsertPayload(
      `INSERT INTO grade_results (id, attempt_id, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET attempt_id = excluded.attempt_id, payload = excluded.payload`,
      [result.id, result.attemptId, JSON.stringify(result), result.createdAt],
    );
    return result;
  }

  async listGradeResultsForTaskset(tasksetId: string): Promise<GradeResult[]> {
    return this.listParsedPayloads(
      `SELECT grades.payload FROM grade_results grades JOIN task_attempts attempts ON attempts.id = grades.attempt_id WHERE attempts.taskset_id = ? ORDER BY grades.created_at ASC`,
      [tasksetId],
      GradeResultSchema.parse,
    );
  }

  async saveBaselineReport(reportInput: BaselineReport): Promise<BaselineReport> {
    const report = BaselineReportSchema.parse(reportInput);
    await this.upsertPayload(
      `INSERT INTO baseline_reports (id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, payload = excluded.payload`,
      [report.id, report.tasksetId, JSON.stringify(report), report.createdAt],
    );
    return report;
  }

  async listBaselineReports(tasksetId: string): Promise<BaselineReport[]> {
    return this.listParsedPayloads("SELECT payload FROM baseline_reports WHERE taskset_id = ? ORDER BY created_at DESC", [tasksetId], BaselineReportSchema.parse);
  }

  async saveGraderAuditReport(reportInput: GraderAuditReport): Promise<GraderAuditReport> {
    const report = GraderAuditReportSchema.parse(reportInput);
    await this.upsertPayload(`INSERT INTO grader_audit_reports (id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, payload = excluded.payload`, [report.id, report.tasksetId, JSON.stringify(report), report.createdAt]);
    return report;
  }

  async listGraderAuditReports(tasksetId: string): Promise<GraderAuditReport[]> {
    return this.listParsedPayloads("SELECT payload FROM grader_audit_reports WHERE taskset_id = ? ORDER BY created_at DESC", [tasksetId], GraderAuditReportSchema.parse);
  }

  async saveReadinessReport(reportInput: TasksetReadinessReport): Promise<TasksetReadinessReport> {
    const report = TasksetReadinessReportSchema.parse(reportInput);
    await this.upsertPayload(
      `INSERT INTO readiness_reports (taskset_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(taskset_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [report.tasksetId, JSON.stringify(report), report.generatedAt],
    );
    return report;
  }

  async getReadinessReport(tasksetId: string): Promise<TasksetReadinessReport | null> {
    return this.getParsedPayload("SELECT payload FROM readiness_reports WHERE taskset_id = ?", [tasksetId], TasksetReadinessReportSchema.parse);
  }

  async saveTaskMinerConfig(profileId: string, configInput: TaskMinerConfig): Promise<TaskMinerConfig> {
    const config = TaskMinerConfigSchema.parse(configInput);
    await this.upsertPayload(
      `INSERT INTO task_miner_configs (profile_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [profileId, JSON.stringify(config), now()],
    );
    return config;
  }

  async getTaskMinerConfig(profileId: string): Promise<TaskMinerConfig | null> {
    return this.getParsedPayload("SELECT payload FROM task_miner_configs WHERE profile_id = ?", [profileId], TaskMinerConfigSchema.parse);
  }

  async saveTaskMinerRun(runInput: TaskMinerRun): Promise<TaskMinerRun> {
    const run = TaskMinerRunSchema.parse(runInput);
    await this.upsertPayload(
      `INSERT INTO task_miner_runs (id, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [run.id, run.profileId, run.status, JSON.stringify(run), run.createdAt, run.updatedAt],
    );
    return run;
  }

  async getTaskMinerRun(id: string): Promise<TaskMinerRun | null> {
    return this.getParsedPayload("SELECT payload FROM task_miner_runs WHERE id = ?", [id], TaskMinerRunSchema.parse);
  }

  async listTaskMinerRuns(profileId: string): Promise<TaskMinerRun[]> {
    return this.listParsedPayloads("SELECT payload FROM task_miner_runs WHERE profile_id = ? ORDER BY updated_at DESC", [profileId], TaskMinerRunSchema.parse);
  }

  async saveTrainingPlan(planInput: TrainingPlan): Promise<TrainingPlan> {
    const plan = TrainingPlanSchema.parse(planInput);
    await this.upsertPayload(
      `INSERT INTO training_plans (id, taskset_id, destination_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, destination_id = excluded.destination_id, payload = excluded.payload`,
      [plan.id, plan.tasksetId, plan.destinationId, JSON.stringify(plan), plan.createdAt],
    );
    return plan;
  }

  async listTrainingPlans(tasksetId?: string): Promise<TrainingPlan[]> {
    return this.listParsedPayloads(tasksetId ? "SELECT payload FROM training_plans WHERE taskset_id = ? ORDER BY created_at DESC" : "SELECT payload FROM training_plans ORDER BY created_at DESC", tasksetId ? [tasksetId] : [], TrainingPlanSchema.parse);
  }

  async getTrainingPlan(id: string): Promise<TrainingPlan | null> {
    return this.getParsedPayload("SELECT payload FROM training_plans WHERE id = ?", [id], TrainingPlanSchema.parse);
  }

  async saveTrainingBundle(bundleInput: TrainingBundleManifest): Promise<TrainingBundleManifest> {
    const bundle = TrainingBundleManifestSchema.parse(bundleInput);
    await this.upsertPayload(
      `INSERT INTO training_bundles (id, plan_id, content_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, content_hash = excluded.content_hash, payload = excluded.payload`,
      [bundle.id, bundle.planId, bundle.contentHash, JSON.stringify(bundle), bundle.createdAt],
    );
    return bundle;
  }

  async getTrainingBundle(id: string): Promise<TrainingBundleManifest | null> {
    return this.getParsedPayload("SELECT payload FROM training_bundles WHERE id = ?", [id], TrainingBundleManifestSchema.parse);
  }

  async listTrainingBundles(planId?: string): Promise<TrainingBundleManifest[]> {
    return this.listParsedPayloads(planId ? "SELECT payload FROM training_bundles WHERE plan_id = ? ORDER BY created_at DESC" : "SELECT payload FROM training_bundles ORDER BY created_at DESC", planId ? [planId] : [], TrainingBundleManifestSchema.parse);
  }

  async findTrainingBundleByPlanAndHash(planId: string, contentHash: string): Promise<TrainingBundleManifest | null> {
    return this.getParsedPayload("SELECT payload FROM training_bundles WHERE plan_id = ? AND content_hash = ?", [planId, contentHash], TrainingBundleManifestSchema.parse);
  }

  async saveTrainingJob(jobInput: TrainingJob): Promise<TrainingJob> {
    const job = TrainingJobSchema.parse(jobInput);
    await this.upsertPayload(
      `INSERT INTO training_jobs (id, plan_id, destination_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, destination_id = excluded.destination_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [job.id, job.planId, job.destinationId, job.status, JSON.stringify(job), job.createdAt, job.updatedAt],
    );
    return job;
  }

  async saveTrainingApproval(approvalInput: TrainingApproval): Promise<TrainingApproval> {
    const approval = TrainingApprovalSchema.parse(approvalInput);
    await this.upsertPayload(
      `INSERT INTO training_approvals (id, plan_id, bundle_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, bundle_hash = excluded.bundle_hash, payload = excluded.payload`,
      [approval.id, approval.planId, approval.bundleHash, JSON.stringify(approval), approval.approvedAt],
    );
    return approval;
  }

  async getTrainingApproval(id: string): Promise<TrainingApproval | null> {
    return this.getParsedPayload("SELECT payload FROM training_approvals WHERE id = ?", [id], TrainingApprovalSchema.parse);
  }

  async getTrainingJob(id: string): Promise<TrainingJob | null> {
    return this.getParsedPayload("SELECT payload FROM training_jobs WHERE id = ?", [id], TrainingJobSchema.parse);
  }

  async listTrainingJobs(): Promise<TrainingJob[]> {
    return this.listParsedPayloads("SELECT payload FROM training_jobs ORDER BY updated_at DESC", [], TrainingJobSchema.parse);
  }

  async saveTrainingJobEvent(eventInput: TrainingJobEvent): Promise<TrainingJobEvent> {
    const event = TrainingJobEventSchema.parse(eventInput);
    await this.upsertPayload(
      `INSERT INTO training_job_events (id, job_id, sequence, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, sequence = excluded.sequence, payload = excluded.payload`,
      [event.id, event.jobId, event.sequence, JSON.stringify(event), event.timestamp],
    );
    return event;
  }

  async listTrainingJobEvents(jobId: string): Promise<TrainingJobEvent[]> {
    return this.listParsedPayloads("SELECT payload FROM training_job_events WHERE job_id = ? ORDER BY sequence ASC", [jobId], TrainingJobEventSchema.parse);
  }

  async saveTrainingArtifact(artifactInput: TrainingArtifact): Promise<TrainingArtifact> {
    const artifact = TrainingArtifactSchema.parse(artifactInput);
    await this.upsertPayload(
      `INSERT INTO training_artifacts (id, job_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, kind = excluded.kind, payload = excluded.payload`,
      [artifact.id, artifact.jobId, artifact.kind, JSON.stringify(artifact), artifact.createdAt],
    );
    return artifact;
  }

  async listTrainingArtifacts(jobId?: string): Promise<TrainingArtifact[]> {
    return this.listParsedPayloads(jobId ? "SELECT payload FROM training_artifacts WHERE job_id = ? ORDER BY created_at DESC" : "SELECT payload FROM training_artifacts ORDER BY created_at DESC", jobId ? [jobId] : [], TrainingArtifactSchema.parse);
  }

  async getTrainingArtifact(id: string): Promise<TrainingArtifact | null> {
    return this.getParsedPayload("SELECT payload FROM training_artifacts WHERE id = ?", [id], TrainingArtifactSchema.parse);
  }

  async saveModelArtifactLineage(lineageInput: ModelArtifactLineage): Promise<ModelArtifactLineage> {
    const lineage = ModelArtifactLineageSchema.parse(lineageInput);
    await this.upsertPayload(
      `INSERT INTO model_artifact_lineage (id, artifact_id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET artifact_id = excluded.artifact_id, taskset_id = excluded.taskset_id, payload = excluded.payload`,
      [lineage.id, lineage.artifactId, lineage.tasksetId, JSON.stringify(lineage), lineage.importedAt],
    );
    return lineage;
  }

  async listModelArtifactLineage(tasksetId?: string): Promise<ModelArtifactLineage[]> {
    return this.listParsedPayloads(tasksetId ? "SELECT payload FROM model_artifact_lineage WHERE taskset_id = ? ORDER BY created_at DESC" : "SELECT payload FROM model_artifact_lineage ORDER BY created_at DESC", tasksetId ? [tasksetId] : [], ModelArtifactLineageSchema.parse);
  }

  async getModelArtifactLineage(id: string): Promise<ModelArtifactLineage | null> {
    return this.getParsedPayload("SELECT payload FROM model_artifact_lineage WHERE id = ?", [id], ModelArtifactLineageSchema.parse);
  }

  private async upsertPayload(sql: string, params: unknown[]): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run(sql, params));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private async listParsedPayloads<T>(sql: string, params: unknown[], parse: (value: unknown) => T): Promise<T[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(sql, params);
    return rows.map((row) => parse(JSON.parse(row.payload)));
  }

  private async getParsedPayload<T>(sql: string, params: unknown[], parse: (value: unknown) => T): Promise<T | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(sql, params);
    return row ? parse(JSON.parse(row.payload)) : null;
  }

}

function trainingChatSearchResult(
  query: string,
  offset: number,
  limit: number,
  total: number,
  rows: TrainingChatSearchResultRow[],
  indexedChats: number,
  totalChats: number,
): TrainingChatSearchResult {
  return {
    schemaVersion: "openpond.trainingChatSearchResult.v1",
    query,
    offset,
    limit,
    total,
    hasMore: offset + rows.length < total,
    indexedChats,
    totalChats,
    indexing: indexedChats < totalChats,
    entries: rows.map((row) => ({
      sessionId: row.session_id,
      title: row.title,
      updatedAt: row.updated_at,
      snippet: row.snippet?.trim() || null,
    })),
  };
}

function trainingChatFtsQuery(query: string): string | null {
  const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function appendTrainingChatSearchText(target: Map<string, string[]>, sessionId: string, text: string): void {
  const values = target.get(sessionId) ?? [];
  values.push(text);
  target.set(sessionId, values);
}
