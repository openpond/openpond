import type { PayloadRow } from "../types.js";
import {
  PreferenceComparisonAssignmentRecordSchema,
  PreferenceComparisonCalibrationRecordSchema,
  PreferenceComparisonReleaseRecordSchema,
  PreferenceComparisonSubmissionRecordSchema,
  type PreferenceComparisonAssignmentRecord,
  type PreferenceComparisonCalibrationRecord,
  type PreferenceComparisonReleaseRecord,
  type PreferenceComparisonSubmissionRecord,
} from "../training/preference-comparison-records.js";
import { SqliteEvaluationResultStore } from "./store-evaluation-results.js";

export class SqlitePreferenceComparisonStore extends SqliteEvaluationResultStore {
  async savePreferenceComparisonRelease(recordInput: PreferenceComparisonReleaseRecord): Promise<PreferenceComparisonReleaseRecord> {
    const record = PreferenceComparisonReleaseRecordSchema.parse(recordInput);
    if (record.id !== record.release.id) throw new Error("Preference comparison release record ID must match its portable release ID.");
    const existing = await this.getPreferenceComparisonRelease(record.id);
    if (existing) {
      if (existing.tasksetId !== record.tasksetId || existing.release.contentHash !== record.release.contentHash) throw new Error("A preference comparison release ID is immutable.");
      if (existing.sourceConsent === "revoked" && record.sourceConsent !== "revoked") throw new Error("Revoked preference-comparison source consent cannot be restored through a release write.");
    }
    await this.upsertPayload(
      `INSERT INTO preference_comparison_releases (id, taskset_id, content_hash, source_consent, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_consent = excluded.source_consent, payload = excluded.payload`,
      [record.id, record.tasksetId, record.release.contentHash, record.sourceConsent, JSON.stringify(record), record.createdAt],
    );
    return record;
  }

  async getPreferenceComparisonRelease(id: string): Promise<PreferenceComparisonReleaseRecord | null> {
    return this.getParsedPayload("SELECT payload FROM preference_comparison_releases WHERE id = ?", [id], PreferenceComparisonReleaseRecordSchema.parse);
  }

  async listPreferenceComparisonReleases(tasksetId: string): Promise<PreferenceComparisonReleaseRecord[]> {
    return this.listParsedPayloads("SELECT payload FROM preference_comparison_releases WHERE taskset_id = ? ORDER BY created_at DESC", [tasksetId], PreferenceComparisonReleaseRecordSchema.parse);
  }

  async revokePreferenceComparisonRelease(input: { id: string; retentionUntil: string | null }): Promise<PreferenceComparisonReleaseRecord> {
    const current = await this.getPreferenceComparisonRelease(input.id);
    if (!current) throw new Error("Preference comparison release was not found.");
    return this.savePreferenceComparisonRelease({ ...current, sourceConsent: "revoked", retentionUntil: input.retentionUntil });
  }

  async savePreferenceComparisonAssignment(recordInput: PreferenceComparisonAssignmentRecord): Promise<PreferenceComparisonAssignmentRecord> {
    const record = PreferenceComparisonAssignmentRecordSchema.parse(recordInput);
    if (record.id !== record.assignment.id) throw new Error("Preference comparison assignment record ID must match its portable assignment ID.");
    const release = await this.getPreferenceComparisonRelease(record.assignment.comparisonRelease.id);
    if (!release || release.tasksetId !== record.tasksetId) throw new Error("Preference comparison assignment references an unavailable Taskset release.");
    if (release.sourceConsent !== "authorized") throw new Error("Preference comparison assignments cannot be created from revoked source consent.");
    if (release.release.contentHash !== record.assignment.comparisonRelease.contentHash) throw new Error("Preference comparison assignment does not reference the persisted immutable release.");
    const existing = await this.getPreferenceComparisonAssignment(record.id);
    if (existing) {
      if (existing.tasksetId !== record.tasksetId || existing.assignment.contentHash !== record.assignment.contentHash) throw new Error("A preference comparison assignment is immutable.");
      if (!isPreferenceAssignmentTransition(existing.state, record.state)) throw new Error("Invalid preference comparison assignment state transition.");
    }
    await this.upsertPayload(
      `INSERT INTO preference_comparison_assignments (id, taskset_id, release_id, purpose, state, reviewer_key, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, reviewer_key = excluded.reviewer_key, payload = excluded.payload, updated_at = excluded.updated_at`,
      [record.id, record.tasksetId, record.assignment.comparisonRelease.id, record.assignment.purpose, record.state, record.reviewerKey, JSON.stringify(record), record.createdAt, record.updatedAt],
    );
    return record;
  }

  async getPreferenceComparisonAssignment(id: string): Promise<PreferenceComparisonAssignmentRecord | null> {
    return this.getParsedPayload("SELECT payload FROM preference_comparison_assignments WHERE id = ?", [id], PreferenceComparisonAssignmentRecordSchema.parse);
  }

  async listPreferenceComparisonAssignments(input: { tasksetId: string; reviewerKey?: string; states?: PreferenceComparisonAssignmentRecord["state"][] }): Promise<PreferenceComparisonAssignmentRecord[]> {
    const states = input.states?.length ? input.states : null;
    const stateSql = states ? ` AND state IN (${states.map(() => "?").join(", ")})` : "";
    const reviewerSql = input.reviewerKey ? " AND (reviewer_key IS NULL OR reviewer_key = ?)" : "";
    return this.listParsedPayloads(
      `SELECT payload FROM preference_comparison_assignments WHERE taskset_id = ?${reviewerSql}${stateSql} ORDER BY created_at ASC`,
      [input.tasksetId, ...(input.reviewerKey ? [input.reviewerKey] : []), ...(states ?? [])],
      PreferenceComparisonAssignmentRecordSchema.parse,
    );
  }

  async claimPreferenceComparisonAssignment(input: { id: string; reviewerKey: string; updatedAt: string }): Promise<PreferenceComparisonAssignmentRecord> {
    const claimed = await this.claimPreferenceComparisonAssignmentRecord(input);
    if (!claimed) throw new Error("Preference comparison assignment is unavailable for this reviewer.");
    return claimed;
  }

  async claimNextPreferenceComparisonAssignment(input: { tasksetId: string; reviewerKey: string; updatedAt: string }): Promise<PreferenceComparisonAssignmentRecord | null> {
    await this.ready;
    let claimed: PreferenceComparisonAssignmentRecord | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<PayloadRow>(
        `SELECT payload FROM preference_comparison_assignments WHERE taskset_id = ? AND (state = 'queued' OR (state = 'in_review' AND reviewer_key = ?))
         ORDER BY CASE state WHEN 'in_review' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
        [input.tasksetId, input.reviewerKey],
      );
      if (!row) return;
      claimed = await this.claimPreferenceComparisonAssignmentRecordInWrite({ current: PreferenceComparisonAssignmentRecordSchema.parse(JSON.parse(row.payload)), reviewerKey: input.reviewerKey, updatedAt: input.updatedAt });
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return claimed;
  }

  async markPreferenceComparisonUnreviewable(input: { id: string; reviewerKey: string; reason: string; updatedAt: string }): Promise<PreferenceComparisonAssignmentRecord> {
    const current = await this.claimPreferenceComparisonAssignment(input);
    return this.savePreferenceComparisonAssignment({ ...current, state: "unreviewable", reviewerKey: input.reviewerKey, unreviewableReason: input.reason, updatedAt: input.updatedAt });
  }

  async savePreferenceComparisonSubmission(recordInput: PreferenceComparisonSubmissionRecord): Promise<PreferenceComparisonSubmissionRecord> {
    const record = PreferenceComparisonSubmissionRecordSchema.parse(recordInput);
    await this.ready;
    let saved: PreferenceComparisonSubmissionRecord | null = null;
    const write = this.writeQueue.then(async () => {
      const assignmentRow = await this.get<PayloadRow>("SELECT payload FROM preference_comparison_assignments WHERE id = ?", [record.assignmentId]);
      if (!assignmentRow) throw new Error("Preference comparison assignment was not found.");
      const current = PreferenceComparisonAssignmentRecordSchema.parse(JSON.parse(assignmentRow.payload));
      const releaseRow = await this.get<PayloadRow>("SELECT payload FROM preference_comparison_releases WHERE id = ?", [current.assignment.comparisonRelease.id]);
      if (!releaseRow) throw new Error("Preference comparison release was not found.");
      if (PreferenceComparisonReleaseRecordSchema.parse(JSON.parse(releaseRow.payload)).sourceConsent !== "authorized") throw new Error("Preference comparison submissions cannot use revoked source consent.");
      if (current.tasksetId !== record.tasksetId) throw new Error("Preference comparison submission Taskset does not match its assignment.");
      if (record.receipt.assignmentRef.id !== current.assignment.id || record.receipt.assignmentRef.contentHash !== current.assignment.contentHash) throw new Error("Preference comparison receipt does not belong to its assignment.");
      const existingRow = await this.get<PayloadRow>("SELECT payload FROM preference_comparison_submissions WHERE assignment_id = ? AND reviewer_key = ?", [record.assignmentId, record.reviewerKey]);
      if (existingRow) {
        const existing = PreferenceComparisonSubmissionRecordSchema.parse(JSON.parse(existingRow.payload));
        if (existing.receipt.contentHash !== record.receipt.contentHash) throw new Error("Preference comparison submission is already recorded for this reviewer and assignment.");
        saved = existing;
        return;
      }
      const assignment = await this.claimPreferenceComparisonAssignmentRecordInWrite({ current, reviewerKey: record.reviewerKey, updatedAt: record.submittedAt });
      if (!assignment) throw new Error("Preference comparison assignment is unavailable for this reviewer.");
      await this.run(
        `INSERT INTO preference_comparison_submissions (id, taskset_id, assignment_id, reviewer_key, receipt_hash, payload, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.tasksetId, record.assignmentId, record.reviewerKey, record.receipt.contentHash, JSON.stringify(record), record.submittedAt],
      );
      await this.writePreferenceComparisonAssignmentInWrite({ ...assignment, state: "submitted", reviewerKey: record.reviewerKey, updatedAt: record.submittedAt });
      saved = record;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!saved) throw new Error("Preference comparison submission was not saved.");
    return saved;
  }

  async getPreferenceComparisonSubmission(input: { assignmentId: string; reviewerKey: string }): Promise<PreferenceComparisonSubmissionRecord | null> {
    return this.getParsedPayload("SELECT payload FROM preference_comparison_submissions WHERE assignment_id = ? AND reviewer_key = ?", [input.assignmentId, input.reviewerKey], PreferenceComparisonSubmissionRecordSchema.parse);
  }

  async listPreferenceComparisonSubmissions(assignmentId: string): Promise<PreferenceComparisonSubmissionRecord[]> {
    return this.listParsedPayloads("SELECT payload FROM preference_comparison_submissions WHERE assignment_id = ? ORDER BY submitted_at ASC", [assignmentId], PreferenceComparisonSubmissionRecordSchema.parse);
  }

  async savePreferenceComparisonCalibration(recordInput: PreferenceComparisonCalibrationRecord): Promise<PreferenceComparisonCalibrationRecord> {
    const record = PreferenceComparisonCalibrationRecordSchema.parse(recordInput);
    const release = await this.getPreferenceComparisonRelease(record.report.comparisonRelease.id);
    if (!release || release.tasksetId !== record.tasksetId) throw new Error("Preference calibration report references an unavailable Taskset release.");
    if (release.release.contentHash !== record.report.comparisonRelease.contentHash) throw new Error("Preference calibration report does not reference the persisted immutable release.");
    await this.upsertPayload(
      `INSERT INTO preference_comparison_calibrations (id, taskset_id, release_id, report_hash, passed, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      [record.id, record.tasksetId, record.report.comparisonRelease.id, record.report.contentHash, record.report.passed ? 1 : 0, JSON.stringify(record), record.createdAt],
    );
    return record;
  }

  async listPreferenceComparisonCalibrations(tasksetId: string): Promise<PreferenceComparisonCalibrationRecord[]> {
    return this.listParsedPayloads("SELECT payload FROM preference_comparison_calibrations WHERE taskset_id = ? ORDER BY created_at DESC", [tasksetId], PreferenceComparisonCalibrationRecordSchema.parse);
  }

  private async claimPreferenceComparisonAssignmentRecord(input: { id: string; reviewerKey: string; updatedAt: string }): Promise<PreferenceComparisonAssignmentRecord | null> {
    await this.ready;
    let claimed: PreferenceComparisonAssignmentRecord | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<PayloadRow>("SELECT payload FROM preference_comparison_assignments WHERE id = ?", [input.id]);
      if (!row) throw new Error("Preference comparison assignment was not found.");
      claimed = await this.claimPreferenceComparisonAssignmentRecordInWrite({ current: PreferenceComparisonAssignmentRecordSchema.parse(JSON.parse(row.payload)), reviewerKey: input.reviewerKey, updatedAt: input.updatedAt });
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return claimed;
  }

  private async claimPreferenceComparisonAssignmentRecordInWrite(input: { current: PreferenceComparisonAssignmentRecord; reviewerKey: string; updatedAt: string }): Promise<PreferenceComparisonAssignmentRecord | null> {
    if (input.current.state === "in_review" && input.current.reviewerKey === input.reviewerKey) return input.current;
    if (input.current.state !== "queued") return null;
    const claimed: PreferenceComparisonAssignmentRecord = { ...input.current, state: "in_review", reviewerKey: input.reviewerKey, updatedAt: input.updatedAt };
    await this.writePreferenceComparisonAssignmentInWrite(claimed);
    return claimed;
  }

  private async writePreferenceComparisonAssignmentInWrite(record: PreferenceComparisonAssignmentRecord): Promise<void> {
    await this.run("UPDATE preference_comparison_assignments SET state = ?, reviewer_key = ?, payload = ?, updated_at = ? WHERE id = ?", [record.state, record.reviewerKey, JSON.stringify(record), record.updatedAt, record.id]);
  }
}

function isPreferenceAssignmentTransition(current: PreferenceComparisonAssignmentRecord["state"], next: PreferenceComparisonAssignmentRecord["state"]): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "in_review" || next === "unreviewable" || next === "revoked";
  if (current === "in_review") return next === "submitted" || next === "unreviewable" || next === "revoked";
  return false;
}
