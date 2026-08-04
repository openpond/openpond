import {
  EvidenceArtifactRefSchema,
  WorkEvidenceReceiptSchema,
  WorkFeedbackReceiptSchema,
  WorkProcessTraceSchema,
  type WorkEvidenceReceipt,
  type WorkFeedbackReceipt,
  type WorkProcessTrace,
} from "@openpond/evals/evidence";
import { z } from "zod";

import type { PayloadRow } from "../types.js";
import { SqliteSidebarFileBookmarkStore } from "./store-sidebar-file-bookmarks.js";

const LocalWorkEvidenceArtifactSchema = z.object({
  kind: z.enum([
    "private_trace",
    "sanitized_trace",
    "evidence_receipt",
    "consent_receipt",
    "output_revision",
    "output_content",
    "validation_evidence",
    "correction",
    "feedback_receipt",
  ]),
  visibility: z.enum(["private", "portable"]),
  ref: EvidenceArtifactRefSchema.nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().trim().min(1).max(8_192),
  sizeBytes: z.number().int().nonnegative(),
}).strict();

export const StoredWorkEvidenceProjectionSchema = z.object({
  schemaVersion: z.literal("openpond.storedWorkEvidenceProjection.v1"),
  sourceSessionId: z.string().trim().min(1),
  sourceTurnId: z.string().trim().min(1),
  sourceRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: WorkEvidenceReceiptSchema,
  trace: WorkProcessTraceSchema,
  artifacts: z.array(LocalWorkEvidenceArtifactSchema).min(3).max(10_100),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const StoredWorkFeedbackSchema = z.object({
  schemaVersion: z.literal("openpond.storedWorkFeedback.v1"),
  receipt: WorkFeedbackReceiptSchema,
  artifacts: z.array(LocalWorkEvidenceArtifactSchema).min(1).max(4),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export class SqliteWorkEvidenceStore extends SqliteSidebarFileBookmarkStore {
  async saveWorkEvidenceProjection(
    input: StoredWorkEvidenceProjection,
  ): Promise<StoredWorkEvidenceProjection> {
    const projection = StoredWorkEvidenceProjectionSchema.parse(input);
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT OR IGNORE INTO work_evidence_receipts (
           id, source_revision_hash, source_session_id, source_turn_id, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          projection.receipt.id,
          projection.sourceRevisionHash,
          projection.sourceSessionId,
          projection.sourceTurnId,
          JSON.stringify(projection),
          projection.createdAt,
        ],
      );
      const row = await this.get<PayloadRow>(
        "SELECT payload FROM work_evidence_receipts WHERE source_revision_hash = ?",
        [projection.sourceRevisionHash],
      );
      if (!row) throw new Error("Work evidence projection was not persisted.");
      const stored = StoredWorkEvidenceProjectionSchema.parse(JSON.parse(row.payload));
      if (stored.receipt.contentHash !== projection.receipt.contentHash) {
        throw new Error("An immutable Work source revision already has different evidence.");
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getWorkEvidenceProjectionBySourceRevision(projection.sourceRevisionHash))!;
  }

  async getWorkEvidenceProjectionBySourceRevision(
    sourceRevisionHash: string,
  ): Promise<StoredWorkEvidenceProjection | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM work_evidence_receipts WHERE source_revision_hash = ?",
      [sourceRevisionHash],
    );
    return row
      ? StoredWorkEvidenceProjectionSchema.parse(JSON.parse(row.payload))
      : null;
  }

  async getWorkEvidenceProjection(
    receiptId: string,
  ): Promise<StoredWorkEvidenceProjection | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM work_evidence_receipts WHERE id = ?",
      [receiptId],
    );
    return row
      ? StoredWorkEvidenceProjectionSchema.parse(JSON.parse(row.payload))
      : null;
  }

  async saveWorkFeedback(input: StoredWorkFeedback): Promise<StoredWorkFeedback> {
    const feedback = StoredWorkFeedbackSchema.parse(input);
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT OR IGNORE INTO work_feedback_receipts (
           id, evidence_receipt_id, output_revision_hash, payload, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [
          feedback.receipt.id,
          feedback.receipt.evidenceReceiptRef.id,
          feedback.receipt.outputRevisionRef?.contentHash ?? null,
          JSON.stringify(feedback),
          feedback.createdAt,
        ],
      );
      const row = await this.get<PayloadRow>(
        "SELECT payload FROM work_feedback_receipts WHERE id = ?",
        [feedback.receipt.id],
      );
      if (!row) throw new Error("Work feedback receipt was not persisted.");
      const stored = StoredWorkFeedbackSchema.parse(JSON.parse(row.payload));
      if (stored.receipt.contentHash !== feedback.receipt.contentHash) {
        throw new Error("An immutable Work feedback id already has different content.");
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getWorkFeedback(feedback.receipt.id))!;
  }

  async getWorkFeedback(id: string): Promise<StoredWorkFeedback | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM work_feedback_receipts WHERE id = ?",
      [id],
    );
    return row ? StoredWorkFeedbackSchema.parse(JSON.parse(row.payload)) : null;
  }

  async listWorkFeedbackForEvidence(
    receipt: WorkEvidenceReceipt,
  ): Promise<StoredWorkFeedback[]> {
    await this.ready;
    await this.writeQueue;
    const receiptRefId = `urn:openpond:artifact:${receipt.contentHash}`;
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM work_feedback_receipts
       WHERE evidence_receipt_id = ? ORDER BY created_at ASC, id ASC`,
      [receiptRefId],
    );
    return rows.map((row) => StoredWorkFeedbackSchema.parse(JSON.parse(row.payload)));
  }
}

export type LocalWorkEvidenceArtifact = z.infer<typeof LocalWorkEvidenceArtifactSchema>;
export type StoredWorkEvidenceProjection = z.infer<typeof StoredWorkEvidenceProjectionSchema> & {
  receipt: WorkEvidenceReceipt;
  trace: WorkProcessTrace;
};
export type StoredWorkFeedback = z.infer<typeof StoredWorkFeedbackSchema> & {
  receipt: WorkFeedbackReceipt;
};
