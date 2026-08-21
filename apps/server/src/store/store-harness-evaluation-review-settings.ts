import type { HarnessEvaluationReviewReceipt } from "@openpond/contracts";

import { SqliteHarnessMemoryStore } from "./store-harness-memory.js";

export type HarnessEvaluationReviewCadence = "manual" | "daily" | "weekly";
export type HarnessBackgroundReviewSettings = { enabled: boolean; updatedAt: string | null };
type HarnessEvaluationReviewClassification = HarnessEvaluationReviewReceipt["classification"];
export type HarnessEvaluationReviewSettings = {
  enabled: boolean;
  activityEnabled: boolean;
  activityBatchSize: number;
  cadence: HarnessEvaluationReviewCadence;
  maxEstimatedCostUsd: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: {
    id: string;
    contentHash: string;
    classification: HarnessEvaluationReviewClassification;
  } | null;
  lastError: string | null;
  updatedAt: string | null;
};

const DEFAULT_SETTINGS: HarnessEvaluationReviewSettings = {
  enabled: false,
  activityEnabled: false,
  activityBatchSize: 10,
  cadence: "manual",
  maxEstimatedCostUsd: 0.1,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  updatedAt: null,
};

export class SqliteHarnessEvaluationReviewSettingsStore extends SqliteHarnessMemoryStore {
  async getHarnessBackgroundReviewSettings(
    workspaceId: string,
  ): Promise<HarnessBackgroundReviewSettings> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ background_review_enabled: number; updated_at: string }>(
      `SELECT background_review_enabled, updated_at
       FROM harness_workspace_settings WHERE workspace_id = ?`,
      [workspaceId],
    );
    return row
      ? { enabled: row.background_review_enabled === 1, updatedAt: row.updated_at }
      : { enabled: true, updatedAt: null };
  }

  async setHarnessBackgroundReviewSettings(input: {
    workspaceId: string;
    enabled: boolean;
    updatedAt: string;
  }): Promise<HarnessBackgroundReviewSettings> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const workspace = await this.get<{ id: string }>(
        "SELECT id FROM harness_workspaces WHERE id = ?",
        [input.workspaceId],
      );
      if (!workspace) throw new Error(`Harness workspace ${input.workspaceId} does not exist.`);
      await this.run(
        `INSERT INTO harness_workspace_settings (
           workspace_id, background_review_enabled, updated_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           background_review_enabled = excluded.background_review_enabled,
           updated_at = excluded.updated_at`,
        [input.workspaceId, input.enabled ? 1 : 0, input.updatedAt],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return { enabled: input.enabled, updatedAt: input.updatedAt };
  }

  async getHarnessEvaluationReviewSettings(
    workspaceId: string,
  ): Promise<HarnessEvaluationReviewSettings> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{
      enabled: number;
      activity_enabled: number;
      activity_batch_size: number;
      cadence: HarnessEvaluationReviewCadence;
      max_estimated_cost_usd: number;
      next_run_at: string | null;
      last_run_at: string | null;
      last_review_id: string | null;
      last_review_hash: string | null;
      last_classification: HarnessEvaluationReviewClassification | null;
      last_error: string | null;
      updated_at: string;
    }>(
      `SELECT enabled, activity_enabled, activity_batch_size, cadence,
              max_estimated_cost_usd, next_run_at, last_run_at,
              last_review_id, last_review_hash, last_classification, last_error, updated_at
       FROM harness_evaluation_review_settings WHERE workspace_id = ?`,
      [workspaceId],
    );
    if (!row) return { ...DEFAULT_SETTINGS };
    const lastResult = row.last_review_id && row.last_review_hash && row.last_classification
      ? {
          id: row.last_review_id,
          contentHash: row.last_review_hash,
          classification: row.last_classification,
        }
      : null;
    return {
      enabled: row.enabled === 1,
      activityEnabled: row.activity_enabled === 1,
      activityBatchSize: row.activity_batch_size,
      cadence: row.cadence,
      maxEstimatedCostUsd: row.max_estimated_cost_usd,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastResult,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    };
  }

  async setHarnessEvaluationReviewSettings(input: {
    workspaceId: string;
    settings: HarnessEvaluationReviewSettings;
  }): Promise<HarnessEvaluationReviewSettings> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const workspace = await this.get<{ id: string }>(
        "SELECT id FROM harness_workspaces WHERE id = ?",
        [input.workspaceId],
      );
      if (!workspace) throw new Error(`Harness workspace ${input.workspaceId} does not exist.`);
      const result = input.settings.lastResult;
      await this.run(
        `INSERT INTO harness_evaluation_review_settings (
           workspace_id, enabled, activity_enabled, activity_batch_size,
           cadence, max_estimated_cost_usd, next_run_at,
           last_run_at, last_review_id, last_review_hash, last_classification,
           last_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           enabled = excluded.enabled,
           activity_enabled = excluded.activity_enabled,
           activity_batch_size = excluded.activity_batch_size,
           cadence = excluded.cadence,
           max_estimated_cost_usd = excluded.max_estimated_cost_usd,
           next_run_at = excluded.next_run_at,
           last_run_at = excluded.last_run_at,
           last_review_id = excluded.last_review_id,
           last_review_hash = excluded.last_review_hash,
           last_classification = excluded.last_classification,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
        [
          input.workspaceId,
          input.settings.enabled ? 1 : 0,
          input.settings.activityEnabled ? 1 : 0,
          input.settings.activityBatchSize,
          input.settings.cadence,
          input.settings.maxEstimatedCostUsd,
          input.settings.nextRunAt,
          input.settings.lastRunAt,
          result?.id ?? null,
          result?.contentHash ?? null,
          result?.classification ?? null,
          input.settings.lastError,
          input.settings.updatedAt ?? new Date().toISOString(),
        ],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return input.settings;
  }
}
