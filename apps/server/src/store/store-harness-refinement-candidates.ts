import {
  HarnessCrossRunRefinementRequestSchema,
  HarnessRefinementCandidateLifecycleReceiptSchema,
  HarnessRefinementCandidateSchema,
  HarnessWorkspaceSchema,
  type HarnessCrossRunRefinementRequest,
  type HarnessRefinementCandidate,
  type HarnessRefinementCandidateLifecycleReceipt,
  type HarnessWorkspace,
} from "@openpond/contracts";

import type { PayloadRow } from "../types.js";
import { SqliteHarnessEvaluationReviewSettingsStore } from "./store-harness-evaluation-review-settings.js";

type CandidateArtifact =
  | HarnessRefinementCandidate
  | HarnessRefinementCandidateLifecycleReceipt
  | HarnessCrossRunRefinementRequest;
type CandidateArtifactKind =
  | "refinement_candidate"
  | "refinement_candidate_lifecycle"
  | "cross_run_refinement_request";

export class SqliteHarnessRefinementCandidateStore
  extends SqliteHarnessEvaluationReviewSettingsStore {
  async listHarnessRefinementCandidates(
    workspaceId: string,
    status?: HarnessRefinementCandidate["status"],
  ): Promise<HarnessRefinementCandidate[]> {
    await this.ready;
    await this.writeQueue;
    const rows = status
      ? await this.all<PayloadRow>(
          `SELECT payload FROM harness_refinement_candidates
           WHERE workspace_id = ? AND status = ?
           ORDER BY updated_at DESC, candidate_id ASC`,
          [workspaceId, status],
        )
      : await this.all<PayloadRow>(
          `SELECT payload FROM harness_refinement_candidates
           WHERE workspace_id = ? ORDER BY updated_at DESC, candidate_id ASC`,
          [workspaceId],
        );
    return rows.map((row) =>
      HarnessRefinementCandidateSchema.parse(JSON.parse(row.payload)),
    );
  }

  async getHarnessRefinementCandidateByFingerprint(
    workspaceId: string,
    fingerprint: string,
  ): Promise<HarnessRefinementCandidate | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      `SELECT payload FROM harness_refinement_candidates
       WHERE workspace_id = ? AND fingerprint = ?`,
      [workspaceId, fingerprint],
    );
    return row
      ? HarnessRefinementCandidateSchema.parse(JSON.parse(row.payload))
      : null;
  }

  async saveHarnessRefinementCandidateTransition(input: {
    workspaceId: string;
    candidate: HarnessRefinementCandidate;
    receipt: HarnessRefinementCandidateLifecycleReceipt;
  }): Promise<HarnessRefinementCandidate> {
    const candidate = HarnessRefinementCandidateSchema.parse(input.candidate);
    const receipt = HarnessRefinementCandidateLifecycleReceiptSchema.parse(input.receipt);
    if (
      receipt.candidateId !== candidate.id
      || receipt.afterCandidate.id !== candidate.id
      || receipt.afterCandidate.contentHash !== candidate.contentHash
    ) {
      throw new Error("Candidate lifecycle receipt is not bound to the candidate revision.");
    }
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const workspace = await this.requireCandidateWorkspace(input.workspaceId);
        if (
          workspace.ownerScope.kind !== candidate.ownerScope.kind
          || workspace.ownerScope.id !== candidate.ownerScope.id
          || candidate.workspaceRef !== workspace.id
        ) {
          throw new Error("Candidate is not bound to the target Harness workspace owner.");
        }
        const currentRow = await this.get<PayloadRow>(
          "SELECT payload FROM harness_refinement_candidates WHERE candidate_id = ?",
          [candidate.id],
        );
        const current = currentRow
          ? HarnessRefinementCandidateSchema.parse(JSON.parse(currentRow.payload))
          : null;
        if (
          (current === null) !== (receipt.beforeCandidate === null)
          || (current && (
            current.id !== receipt.beforeCandidate?.id
            || current.contentHash !== receipt.beforeCandidate.contentHash
          ))
        ) {
          throw new Error("Candidate lifecycle transition does not match the current revision.");
        }
        await this.insertCandidateArtifact(
          input.workspaceId,
          "refinement_candidate",
          candidate,
        );
        await this.insertCandidateArtifact(
          input.workspaceId,
          "refinement_candidate_lifecycle",
          receipt,
        );
        await this.run(
          `INSERT INTO harness_refinement_candidates (
             candidate_id, workspace_id, fingerprint, status, content_hash,
             payload, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(candidate_id) DO UPDATE SET
             fingerprint = excluded.fingerprint,
             status = excluded.status,
             content_hash = excluded.content_hash,
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
          [
            candidate.id,
            input.workspaceId,
            candidate.fingerprint,
            candidate.status,
            candidate.contentHash,
            JSON.stringify(candidate),
            candidate.createdAt,
            candidate.updatedAt,
          ],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return candidate;
  }

  async saveHarnessCrossRunRefinementRequestIfAbsent(input: {
    workspaceId: string;
    request: HarnessCrossRunRefinementRequest;
  }): Promise<{ request: HarnessCrossRunRefinementRequest; created: boolean }> {
    const request = HarnessCrossRunRefinementRequestSchema.parse(input.request);
    if (request.workspaceRef !== input.workspaceId) {
      throw new Error("Cross-run refinement request is not bound to the target workspace.");
    }
    await this.ready;
    let result: { request: HarnessCrossRunRefinementRequest; created: boolean } | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.requireCandidateWorkspace(input.workspaceId);
        const existing = await this.get<PayloadRow>(
          `SELECT payload FROM harness_cross_run_refinement_requests
           WHERE deduplication_key = ?`,
          [request.deduplicationKey],
        );
        if (existing) {
          result = {
            request: HarnessCrossRunRefinementRequestSchema.parse(JSON.parse(existing.payload)),
            created: false,
          };
        } else {
          await this.insertCandidateArtifact(
            input.workspaceId,
            "cross_run_refinement_request",
            request,
          );
          await this.run(
            `INSERT INTO harness_cross_run_refinement_requests (
               deduplication_key, workspace_id, candidate_id,
               admitted_release_hash, content_hash, payload, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              request.deduplicationKey,
              input.workspaceId,
              request.candidate.id,
              request.admittedHarness.contentHash,
              request.contentHash,
              JSON.stringify(request),
              request.createdAt,
            ],
          );
          result = { request, created: true };
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!result) throw new Error("Cross-run refinement request was not persisted.");
    return result;
  }

  private async requireCandidateWorkspace(id: string): Promise<HarnessWorkspace> {
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM harness_workspaces WHERE id = ?",
      [id],
    );
    if (!row) throw new Error(`Harness workspace ${id} does not exist.`);
    return HarnessWorkspaceSchema.parse(JSON.parse(row.payload));
  }

  private async insertCandidateArtifact(
    workspaceId: string,
    kind: CandidateArtifactKind,
    artifact: CandidateArtifact,
  ): Promise<void> {
    const serialized = JSON.stringify(artifact);
    const sameHash = await this.get<PayloadRow>(
      "SELECT payload FROM harness_improvement_artifacts WHERE content_hash = ?",
      [artifact.contentHash],
    );
    if (sameHash) {
      if (sameHash.payload !== serialized) {
        throw new Error("An immutable Harness improvement artifact hash already has different content.");
      }
      return;
    }
    if (kind !== "refinement_candidate") {
      const sameIdentity = await this.get<PayloadRow>(
        "SELECT payload FROM harness_improvement_artifacts WHERE id = ? AND kind = ?",
        [artifact.id, kind],
      );
      if (sameIdentity) {
        throw new Error("An immutable Harness improvement artifact id already has different content.");
      }
    }
    await this.run(
      `INSERT INTO harness_improvement_artifacts (
         content_hash, id, workspace_id, kind, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        artifact.contentHash,
        artifact.id,
        workspaceId,
        kind,
        serialized,
        artifact.createdAt,
      ],
    );
  }
}
