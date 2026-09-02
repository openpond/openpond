import {
  ContinualBenchIssueReviewSchema,
  ContinualLearningDailyBatchSchema,
  type ContinualBenchIssueReview,
  type ContinualLearningDailyBatch,
} from "@openpond/contracts";

import { SqliteTrainingModelStore } from "./store-training-models.js";

export class SqliteContinualBenchReviewStore extends SqliteTrainingModelStore {
  async saveContinualLearningDailyBatch(batchInput: ContinualLearningDailyBatch): Promise<ContinualLearningDailyBatch> {
    const batch = ContinualLearningDailyBatchSchema.parse(batchInput);
    const existing = await this.getContinualLearningDailyBatch(batch.id);
    if (existing) {
      if (
        existing.seriesId !== batch.seriesId
        || existing.scheduleEntryId !== batch.scheduleEntryId
        || existing.dayOrdinal !== batch.dayOrdinal
        || JSON.stringify(existing.sourceTaskset) !== JSON.stringify(batch.sourceTaskset)
        || batch.revision !== existing.revision + 1
      ) {
        if (JSON.stringify(existing) === JSON.stringify(batch)) return existing;
        throw new Error("A daily learning batch update must preserve its intake identity and use the next revision.");
      }
    }
    await this.upsertPayload(
      `INSERT INTO continual_learning_daily_batches
        (id, series_id, schedule_entry_id, day_ordinal, status, revision, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`,
      [batch.id, batch.seriesId, batch.scheduleEntryId, batch.dayOrdinal, batch.status, batch.revision, JSON.stringify(batch), batch.createdAt, batch.updatedAt],
    );
    return batch;
  }

  async getContinualLearningDailyBatch(id: string): Promise<ContinualLearningDailyBatch | null> {
    return this.getParsedPayload("SELECT payload FROM continual_learning_daily_batches WHERE id = ?", [id], ContinualLearningDailyBatchSchema.parse);
  }

  async listContinualLearningDailyBatches(input: { seriesId?: string } = {}): Promise<ContinualLearningDailyBatch[]> {
    return input.seriesId
      ? this.listParsedPayloads("SELECT payload FROM continual_learning_daily_batches WHERE series_id = ? ORDER BY day_ordinal ASC", [input.seriesId], ContinualLearningDailyBatchSchema.parse)
      : this.listParsedPayloads("SELECT payload FROM continual_learning_daily_batches ORDER BY series_id, day_ordinal ASC", [], ContinualLearningDailyBatchSchema.parse);
  }

  async saveContinualBenchIssueReview(reviewInput: ContinualBenchIssueReview): Promise<ContinualBenchIssueReview> {
    const review = ContinualBenchIssueReviewSchema.parse(reviewInput);
    const existing = await this.getContinualBenchIssueReview(review.id);
    if (existing && (existing.seriesId !== review.seriesId || existing.passLabel !== review.passLabel || existing.packet.contentHash !== review.packet.contentHash || review.revision !== existing.revision + 1)) {
      if (JSON.stringify(existing) === JSON.stringify(review)) return existing;
      throw new Error("A Continual Support review update must preserve its sealed packet and use the next revision.");
    }
    await this.upsertPayload(
      `INSERT INTO continual_bench_issue_reviews (id, series_id, pass_label, status, revision, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`,
      [review.id, review.seriesId, review.passLabel, review.status, review.revision, JSON.stringify(review), review.createdAt, review.updatedAt],
    );
    return review;
  }

  async getContinualBenchIssueReview(id: string): Promise<ContinualBenchIssueReview | null> {
    return this.getParsedPayload("SELECT payload FROM continual_bench_issue_reviews WHERE id = ?", [id], ContinualBenchIssueReviewSchema.parse);
  }

  async listContinualBenchIssueReviews(input: { seriesId?: string } = {}): Promise<ContinualBenchIssueReview[]> {
    return input.seriesId
      ? this.listParsedPayloads("SELECT payload FROM continual_bench_issue_reviews WHERE series_id = ? ORDER BY updated_at DESC", [input.seriesId], ContinualBenchIssueReviewSchema.parse)
      : this.listParsedPayloads("SELECT payload FROM continual_bench_issue_reviews ORDER BY updated_at DESC", [], ContinualBenchIssueReviewSchema.parse);
  }
}
