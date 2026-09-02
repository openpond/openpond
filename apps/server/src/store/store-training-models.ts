import type {
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  ModelCurrencySnapshot,
  ModelBinding,
  ModelRun,
  ModelVersion,
  RewardModelRun,
  RewardModelVersion,
  RolloutTrajectoryReceipt,
} from "@openpond/contracts";
import {
  ModelComparisonSeriesEntrySchema,
  ModelComparisonSeriesSchema,
  ModelCurrencySnapshotSchema,
  ModelBindingSchema,
  ModelRunSchema,
  ModelVersionSchema,
  RewardModelRunSchema,
  RewardModelVersionSchema,
  RolloutTrajectoryReceiptSchema,
} from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { SqliteStoreCore } from "./store-core.js";

export class SqliteTrainingModelStore extends SqliteStoreCore {
  async saveModelCurrencySnapshot(snapshotInput: ModelCurrencySnapshot): Promise<ModelCurrencySnapshot> {
    const snapshot = ModelCurrencySnapshotSchema.parse(snapshotInput);
    const existing = await this.getModelCurrencySnapshot(snapshot.id);
    if (existing) {
      if (existing.contentHash === snapshot.contentHash && JSON.stringify(existing) === JSON.stringify(snapshot)) return existing;
      throw new Error("An immutable Model Currency Snapshot cannot be replaced.");
    }
    await this.upsertPayload(
      `INSERT INTO model_currency_snapshots
        (id, series_id, entry_id, evidence_state, content_hash, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [snapshot.id, snapshot.seriesId, snapshot.entryId, snapshot.evidenceState, snapshot.contentHash, JSON.stringify(snapshot), snapshot.projectedAt],
    );
    return snapshot;
  }

  async getModelCurrencySnapshot(id: string): Promise<ModelCurrencySnapshot | null> {
    return this.getParsedPayload("SELECT payload FROM model_currency_snapshots WHERE id = ?", [id], ModelCurrencySnapshotSchema.parse);
  }

  async listModelCurrencySnapshots(input: { seriesId?: string; entryId?: string } = {}): Promise<ModelCurrencySnapshot[]> {
    if (input.entryId) return this.listParsedPayloads("SELECT payload FROM model_currency_snapshots WHERE entry_id = ? ORDER BY created_at DESC", [input.entryId], ModelCurrencySnapshotSchema.parse);
    if (input.seriesId) return this.listParsedPayloads("SELECT payload FROM model_currency_snapshots WHERE series_id = ? ORDER BY created_at DESC", [input.seriesId], ModelCurrencySnapshotSchema.parse);
    return this.listParsedPayloads("SELECT payload FROM model_currency_snapshots ORDER BY created_at DESC", [], ModelCurrencySnapshotSchema.parse);
  }

  async saveModelComparisonSeries(
    seriesInput: ModelComparisonSeries,
  ): Promise<ModelComparisonSeries> {
    const series = ModelComparisonSeriesSchema.parse(seriesInput);
    const existing = await this.getModelComparisonSeries(series.id);
    if (
      existing
      && (
        existing.profileId !== series.profileId
        || existing.modelProjectId !== series.modelProjectId
        || existing.createdAt !== series.createdAt
      )
    ) {
      throw new Error("A Model Comparison Series cannot change its immutable ownership.");
    }
    if (existing && series.revision !== existing.revision + 1) {
      if (JSON.stringify(existing) === JSON.stringify(series)) return existing;
      throw new Error("A Model Comparison Series update requires the next revision.");
    }
    if (existing?.scheduleSealedAt && !sameSealedSeriesDefinition(existing, series)) {
      throw new Error("A sealed Model Comparison Series definition is immutable.");
    }
    await this.upsertPayload(
      `INSERT INTO model_comparison_series
        (id, profile_id, model_project_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        series.id,
        series.profileId,
        series.modelProjectId,
        series.status,
        JSON.stringify(series),
        series.createdAt,
        series.updatedAt,
      ],
    );
    return series;
  }

  async getModelComparisonSeries(id: string): Promise<ModelComparisonSeries | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_comparison_series WHERE id = ?",
      [id],
      ModelComparisonSeriesSchema.parse,
    );
  }

  async listModelComparisonSeries(input: {
    profileId?: string;
    modelProjectId?: string;
  } = {}): Promise<ModelComparisonSeries[]> {
    if (input.modelProjectId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_comparison_series WHERE model_project_id = ? ORDER BY updated_at DESC",
        [input.modelProjectId],
        ModelComparisonSeriesSchema.parse,
      );
    }
    if (input.profileId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_comparison_series WHERE profile_id = ? ORDER BY updated_at DESC",
        [input.profileId],
        ModelComparisonSeriesSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM model_comparison_series ORDER BY updated_at DESC",
      [],
      ModelComparisonSeriesSchema.parse,
    );
  }

  async saveModelComparisonSeriesEntry(
    entryInput: ModelComparisonSeriesEntry,
  ): Promise<ModelComparisonSeriesEntry> {
    const entry = ModelComparisonSeriesEntrySchema.parse(entryInput);
    const existing = await this.getModelComparisonSeriesEntry(entry.id);
    if (existing && !sameEntryLineage(existing, entry)) {
      throw new Error("A Model Comparison Series Entry cannot change its immutable release lineage.");
    }
    if (existing && !validEntryEvidenceEvolution(existing, entry)) {
      throw new Error("A Model Comparison Series Entry cannot replace linked evidence or artifact lineage.");
    }
    await this.upsertPayload(
      `INSERT INTO model_comparison_series_entries
        (id, series_id, profile_id, model_project_id, ordinal, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        entry.id,
        entry.seriesId,
        entry.profileId,
        entry.modelProjectId,
        entry.ordinal,
        entry.status,
        JSON.stringify(entry),
        entry.createdAt,
        entry.updatedAt,
      ],
    );
    return entry;
  }

  async getModelComparisonSeriesEntry(id: string): Promise<ModelComparisonSeriesEntry | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_comparison_series_entries WHERE id = ?",
      [id],
      ModelComparisonSeriesEntrySchema.parse,
    );
  }

  async listModelComparisonSeriesEntries(input: {
    seriesId?: string;
    modelProjectId?: string;
  } = {}): Promise<ModelComparisonSeriesEntry[]> {
    if (input.seriesId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_comparison_series_entries WHERE series_id = ? ORDER BY ordinal ASC",
        [input.seriesId],
        ModelComparisonSeriesEntrySchema.parse,
      );
    }
    if (input.modelProjectId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_comparison_series_entries WHERE model_project_id = ? ORDER BY updated_at DESC",
        [input.modelProjectId],
        ModelComparisonSeriesEntrySchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM model_comparison_series_entries ORDER BY updated_at DESC",
      [],
      ModelComparisonSeriesEntrySchema.parse,
    );
  }

  async commitModelComparisonSeriesMutation(input: {
    expectedSeriesRevision: number;
    series: ModelComparisonSeries;
    entry: ModelComparisonSeriesEntry;
    expectedEntryStatus: ModelComparisonSeriesEntry["status"] | null;
  }): Promise<{ series: ModelComparisonSeries; entry: ModelComparisonSeriesEntry }> {
    const nextSeries = ModelComparisonSeriesSchema.parse(input.series);
    const nextEntry = ModelComparisonSeriesEntrySchema.parse(input.entry);
    await this.ready;
    let result = { series: nextSeries, entry: nextEntry };
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const seriesRow = await this.get<PayloadRow>(
          "SELECT payload FROM model_comparison_series WHERE id = ?",
          [nextSeries.id],
        );
        if (!seriesRow) throw new Error("Model Comparison Series not found.");
        const currentSeries = ModelComparisonSeriesSchema.parse(JSON.parse(seriesRow.payload));
        if (currentSeries.revision !== input.expectedSeriesRevision) {
          throw new Error(`Comparison Series revision changed; expected ${input.expectedSeriesRevision} and found ${currentSeries.revision}.`);
        }
        if (nextSeries.revision !== currentSeries.revision + 1) {
          throw new Error("A Comparison Series mutation must advance exactly one revision.");
        }
        if (currentSeries.scheduleSealedAt && !sameSealedSeriesDefinition(currentSeries, nextSeries)) {
          throw new Error("A sealed Model Comparison Series definition is immutable.");
        }
        const entryRow = await this.get<PayloadRow>(
          "SELECT payload FROM model_comparison_series_entries WHERE id = ?",
          [nextEntry.id],
        );
        const currentEntry = entryRow
          ? ModelComparisonSeriesEntrySchema.parse(JSON.parse(entryRow.payload))
          : null;
        if ((currentEntry?.status ?? null) !== input.expectedEntryStatus) {
          throw new Error("The Comparison Series Entry changed before the mutation could be applied.");
        }
        if (currentEntry && !sameEntryLineage(currentEntry, nextEntry)) {
          throw new Error("A Model Comparison Series Entry cannot change its immutable release lineage.");
        }
        if (currentEntry && !validEntryEvidenceEvolution(currentEntry, nextEntry)) {
          throw new Error("A Model Comparison Series Entry cannot replace linked evidence or artifact lineage.");
        }
        await this.run(
          `INSERT INTO model_comparison_series_entries
            (id, series_id, profile_id, model_project_id, ordinal, status, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
          [nextEntry.id, nextEntry.seriesId, nextEntry.profileId, nextEntry.modelProjectId, nextEntry.ordinal,
            nextEntry.status, JSON.stringify(nextEntry), nextEntry.createdAt, nextEntry.updatedAt],
        );
        await this.run(
          `UPDATE model_comparison_series SET status = ?, payload = ?, updated_at = ? WHERE id = ?`,
          [nextSeries.status, JSON.stringify(nextSeries), nextSeries.updatedAt, nextSeries.id],
        );
        await this.exec("COMMIT");
        result = { series: nextSeries, entry: nextEntry };
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return result;
  }

  async compareAndSwapModelComparisonSeriesEntry(input: {
    expectedStatus: ModelComparisonSeriesEntry["status"];
    entry: ModelComparisonSeriesEntry;
  }): Promise<ModelComparisonSeriesEntry> {
    const next = ModelComparisonSeriesEntrySchema.parse(input.entry);
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const row = await this.get<PayloadRow>(
          "SELECT payload FROM model_comparison_series_entries WHERE id = ?",
          [next.id],
        );
        if (!row) throw new Error("Model Comparison Series Entry not found.");
        const current = ModelComparisonSeriesEntrySchema.parse(JSON.parse(row.payload));
        if (current.status !== input.expectedStatus) {
          throw new Error(`Comparison entry state changed; expected ${input.expectedStatus} and found ${current.status}.`);
        }
        if (!sameEntryLineage(current, next)) {
          throw new Error("A Model Comparison Series Entry cannot change its immutable release lineage.");
        }
        if (!validEntryEvidenceEvolution(current, next)) {
          throw new Error("A Model Comparison Series Entry cannot replace linked evidence or artifact lineage.");
        }
        await this.run(
          "UPDATE model_comparison_series_entries SET status = ?, payload = ?, updated_at = ? WHERE id = ?",
          [next.status, JSON.stringify(next), next.updatedAt, next.id],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return next;
  }

  async saveRewardModelVersion(
    versionInput: RewardModelVersion,
  ): Promise<RewardModelVersion> {
    const version = RewardModelVersionSchema.parse(versionInput);
    const existing = await this.getRewardModelVersion(version.id);
    if (existing && existing.contentHash !== version.contentHash) {
      throw new Error(`Reward Model Version ${version.id} is immutable and already has different content.`);
    }
    await this.upsertPayload(
      `INSERT INTO reward_model_versions
        (id, model_id, profile_id, version_number, taskset_id, status, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      [
        version.id,
        version.modelId,
        version.profileId,
        version.version,
        version.taskset.id,
        version.status,
        JSON.stringify(version),
        version.createdAt,
      ],
    );
    return version;
  }

  async getRewardModelVersion(id: string): Promise<RewardModelVersion | null> {
    return this.getParsedPayload(
      "SELECT payload FROM reward_model_versions WHERE id = ?",
      [id],
      RewardModelVersionSchema.parse,
    );
  }

  async listRewardModelVersions(input: {
    profileId?: string;
    tasksetId?: string;
  } = {}): Promise<RewardModelVersion[]> {
    if (input.tasksetId) {
      return this.listParsedPayloads(
        "SELECT payload FROM reward_model_versions WHERE taskset_id = ? ORDER BY created_at DESC",
        [input.tasksetId],
        RewardModelVersionSchema.parse,
      );
    }
    if (input.profileId) {
      return this.listParsedPayloads(
        "SELECT payload FROM reward_model_versions WHERE profile_id = ? ORDER BY created_at DESC",
        [input.profileId],
        RewardModelVersionSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM reward_model_versions ORDER BY created_at DESC",
      [],
      RewardModelVersionSchema.parse,
    );
  }

  async saveRewardModelRun(runInput: RewardModelRun): Promise<RewardModelRun> {
    const run = RewardModelRunSchema.parse(runInput);
    const existing = await this.getRewardModelRun(run.id);
    if (
      existing &&
      (existing.rewardModelId !== run.rewardModelId ||
        existing.profileId !== run.profileId ||
        existing.taskset.id !== run.taskset.id ||
        existing.preferenceDatasetRelease.contentHash !== run.preferenceDatasetRelease.contentHash)
    ) {
      throw new Error("A Reward Model Run cannot change its immutable lineage.");
    }
    if (
      existing &&
      ["succeeded", "failed", "cancelled"].includes(existing.status) &&
      JSON.stringify(existing) !== JSON.stringify(run)
    ) {
      throw new Error(`Terminal Reward Model Run ${run.id} is immutable.`);
    }
    await this.upsertPayload(
      `INSERT INTO reward_model_runs
        (id, reward_model_id, profile_id, taskset_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        run.id,
        run.rewardModelId,
        run.profileId,
        run.taskset.id,
        run.status,
        JSON.stringify(run),
        run.startedAt,
        run.updatedAt,
      ],
    );
    return run;
  }

  async getRewardModelRun(id: string): Promise<RewardModelRun | null> {
    return this.getParsedPayload(
      "SELECT payload FROM reward_model_runs WHERE id = ?",
      [id],
      RewardModelRunSchema.parse,
    );
  }

  async listRewardModelRuns(input: {
    profileId?: string;
    tasksetId?: string;
  } = {}): Promise<RewardModelRun[]> {
    if (input.tasksetId) {
      return this.listParsedPayloads(
        "SELECT payload FROM reward_model_runs WHERE taskset_id = ? ORDER BY updated_at DESC",
        [input.tasksetId],
        RewardModelRunSchema.parse,
      );
    }
    if (input.profileId) {
      return this.listParsedPayloads(
        "SELECT payload FROM reward_model_runs WHERE profile_id = ? ORDER BY updated_at DESC",
        [input.profileId],
        RewardModelRunSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM reward_model_runs ORDER BY updated_at DESC",
      [],
      RewardModelRunSchema.parse,
    );
  }

  async saveModelVersion(
    versionInput: ModelVersion,
  ): Promise<ModelVersion> {
    const version = ModelVersionSchema.parse(versionInput);
    const existing = await this.getModelVersion(version.id);
    if (existing && existing.contentHash !== version.contentHash) {
      throw new Error(
        `Model Version ${version.id} is immutable and already has different content.`,
      );
    }
    const conflicting = (
      await this.listModelVersions({ modelId: version.modelId })
    ).find((candidate) => candidate.version === version.version);
    if (conflicting && conflicting.id !== version.id) {
      throw new Error(
        `Model ${version.modelId} already has version ${version.version}.`,
      );
    }
    await this.upsertPayload(
      `INSERT INTO model_versions
        (id, model_id, profile_id, version_number, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      [
        version.id,
        version.modelId,
        version.profileId,
        version.version,
        version.kind,
        JSON.stringify(version),
        version.createdAt,
      ],
    );
    return version;
  }

  async getModelVersion(id: string): Promise<ModelVersion | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_versions WHERE id = ?",
      [id],
      ModelVersionSchema.parse,
    );
  }

  async listModelVersions(input: {
    profileId?: string;
    modelId?: string;
  } = {}): Promise<ModelVersion[]> {
    if (input.modelId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_versions WHERE model_id = ? ORDER BY version_number DESC",
        [input.modelId],
        ModelVersionSchema.parse,
      );
    }
    if (input.profileId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_versions WHERE profile_id = ? ORDER BY created_at DESC",
        [input.profileId],
        ModelVersionSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM model_versions ORDER BY created_at DESC",
      [],
      ModelVersionSchema.parse,
    );
  }

  async saveModelRun(runInput: ModelRun): Promise<ModelRun> {
    const modelRun = ModelRunSchema.parse(runInput);
    const existing = await this.getModelRun(modelRun.id);
    if (
      existing
      && (
        existing.modelId !== modelRun.modelId
        || existing.modelVersionId !== modelRun.modelVersionId
        || existing.profileId !== modelRun.profileId
        || existing.taskset.id !== modelRun.taskset.id
        || JSON.stringify(existing.comparisonSeriesEntry ?? null)
          !== JSON.stringify(modelRun.comparisonSeriesEntry ?? null)
      )
    ) {
      throw new Error("A Model Run cannot change its immutable lineage.");
    }
    if (
      existing
      && ["succeeded", "failed", "cancelled"].includes(existing.status)
      && JSON.stringify(existing) !== JSON.stringify(modelRun)
      && !isCheckpointResumeTransition(existing, modelRun)
    ) {
      throw new Error(`Terminal Model Run ${modelRun.id} is immutable.`);
    }
    await this.upsertPayload(
      `INSERT INTO model_runs
        (id, model_id, model_version_id, profile_id, taskset_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        modelRun.id,
        modelRun.modelId,
        modelRun.modelVersionId,
        modelRun.profileId,
        modelRun.taskset.id,
        modelRun.status,
        JSON.stringify(modelRun),
        modelRun.startedAt,
        modelRun.updatedAt,
      ],
    );
    return modelRun;
  }

  async getModelRun(id: string): Promise<ModelRun | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_runs WHERE id = ?",
      [id],
      ModelRunSchema.parse,
    );
  }

  async listModelRuns(input: {
    profileId?: string;
    modelId?: string;
    tasksetId?: string;
  } = {}): Promise<ModelRun[]> {
    if (input.modelId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_runs WHERE model_id = ? ORDER BY updated_at DESC",
        [input.modelId],
        ModelRunSchema.parse,
      );
    }
    if (input.tasksetId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_runs WHERE taskset_id = ? ORDER BY updated_at DESC",
        [input.tasksetId],
        ModelRunSchema.parse,
      );
    }
    if (input.profileId) {
      return this.listParsedPayloads(
        "SELECT payload FROM model_runs WHERE profile_id = ? ORDER BY updated_at DESC",
        [input.profileId],
        ModelRunSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM model_runs ORDER BY updated_at DESC",
      [],
      ModelRunSchema.parse,
    );
  }

  async saveRolloutTrajectoryReceipt(
    receiptInput: RolloutTrajectoryReceipt,
  ): Promise<RolloutTrajectoryReceipt> {
    const receipt = RolloutTrajectoryReceiptSchema.parse(receiptInput);
    await this.upsertPayload(
      `INSERT INTO training_rollout_receipts (id, job_id, taskset_id, provider_rollout_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, taskset_id = excluded.taskset_id,
         provider_rollout_id = excluded.provider_rollout_id, status = excluded.status,
         payload = excluded.payload, updated_at = excluded.updated_at`,
      [
        receipt.id,
        receipt.jobId,
        receipt.tasksetId,
        receipt.providerTrace.rolloutId,
        receipt.status,
        JSON.stringify(receipt),
        receipt.receivedAt,
        receipt.updatedAt,
      ],
    );
    return receipt;
  }

  async getRolloutTrajectoryReceiptByProviderId(
    providerRolloutId: string,
  ): Promise<RolloutTrajectoryReceipt | null> {
    return this.getParsedPayload(
      "SELECT payload FROM training_rollout_receipts WHERE provider_rollout_id = ?",
      [providerRolloutId],
      RolloutTrajectoryReceiptSchema.parse,
    );
  }

  async listRolloutTrajectoryReceipts(input: {
    jobId?: string;
    tasksetId?: string;
  } = {}): Promise<RolloutTrajectoryReceipt[]> {
    if (input.jobId) {
      return this.listParsedPayloads(
        "SELECT payload FROM training_rollout_receipts WHERE job_id = ? ORDER BY updated_at DESC",
        [input.jobId],
        RolloutTrajectoryReceiptSchema.parse,
      );
    }
    if (input.tasksetId) {
      return this.listParsedPayloads(
        "SELECT payload FROM training_rollout_receipts WHERE taskset_id = ? ORDER BY updated_at DESC",
        [input.tasksetId],
        RolloutTrajectoryReceiptSchema.parse,
      );
    }
    return this.listParsedPayloads(
      "SELECT payload FROM training_rollout_receipts ORDER BY updated_at DESC",
      [],
      RolloutTrajectoryReceiptSchema.parse,
    );
  }

  async saveModelBinding(bindingInput: ModelBinding): Promise<ModelBinding> {
    const binding = ModelBindingSchema.parse(bindingInput);
    await this.upsertPayload(
      `INSERT INTO model_bindings (id, profile_id, role, role_target_id, model_artifact_lineage_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, role = excluded.role,
         role_target_id = excluded.role_target_id, model_artifact_lineage_id = excluded.model_artifact_lineage_id,
         status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [
        binding.id,
        binding.profileId,
        binding.role,
        binding.roleTargetId,
        binding.modelArtifactLineageId,
        binding.status,
        JSON.stringify(binding),
        binding.promotedAt,
        binding.rolledBackAt ?? binding.promotedAt,
      ],
    );
    return binding;
  }

  async replaceActiveModelBinding(input: {
    profileId: string;
    role: ModelBinding["role"];
    roleTargetId: string;
    expectedActiveBindingId: string | null;
    next: ModelBinding | null;
    timestamp: string;
  }): Promise<{ previous: ModelBinding | null; active: ModelBinding | null }> {
    const next = input.next ? ModelBindingSchema.parse(input.next) : null;
    if (
      next
      && (
        next.status !== "active"
        || next.profileId !== input.profileId
        || next.role !== input.role
        || next.roleTargetId !== input.roleTargetId
      )
    ) {
      throw new Error("Replacement Model binding does not match the requested active role.");
    }
    await this.ready;
    let result: { previous: ModelBinding | null; active: ModelBinding | null } = {
      previous: null,
      active: null,
    };
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const row = await this.get<PayloadRow>(
          "SELECT payload FROM model_bindings WHERE profile_id = ? AND role = ? AND role_target_id = ? AND status = 'active' LIMIT 1",
          [input.profileId, input.role, input.roleTargetId],
        );
        const current = row ? ModelBindingSchema.parse(JSON.parse(row.payload)) : null;
        if ((current?.id ?? null) !== input.expectedActiveBindingId) {
          throw new Error("The active Model binding changed before this promotion could be applied.");
        }
        if (current) {
          const rolledBack = ModelBindingSchema.parse({
            ...current,
            status: "rolled_back",
            rolledBackAt: input.timestamp,
          });
          await this.run(
            `UPDATE model_bindings
             SET status = 'rolled_back', payload = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
            [JSON.stringify(rolledBack), input.timestamp, current.id],
          );
        }
        if (next) {
          await this.run(
            `INSERT INTO model_bindings
              (id, profile_id, role, role_target_id, model_artifact_lineage_id, status, payload, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              next.id,
              next.profileId,
              next.role,
              next.roleTargetId,
              next.modelArtifactLineageId,
              next.status,
              JSON.stringify(next),
              next.promotedAt,
              next.promotedAt,
            ],
          );
        }
        await this.exec("COMMIT");
        result = { previous: current, active: next };
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return result;
  }

  async getModelBinding(id: string): Promise<ModelBinding | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_bindings WHERE id = ?",
      [id],
      ModelBindingSchema.parse,
    );
  }

  async getActiveModelBinding(input: {
    profileId: string;
    role: ModelBinding["role"];
    roleTargetId: string;
  }): Promise<ModelBinding | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_bindings WHERE profile_id = ? AND role = ? AND role_target_id = ? AND status = 'active' LIMIT 1",
      [input.profileId, input.role, input.roleTargetId],
      ModelBindingSchema.parse,
    );
  }

  async listModelBindings(profileId?: string): Promise<ModelBinding[]> {
    return this.listParsedPayloads(
      profileId
        ? "SELECT payload FROM model_bindings WHERE profile_id = ? ORDER BY updated_at DESC"
        : "SELECT payload FROM model_bindings ORDER BY updated_at DESC",
      profileId ? [profileId] : [],
      ModelBindingSchema.parse,
    );
  }

  protected async upsertPayload(sql: string, params: unknown[]): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run(sql, params));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  protected async listParsedPayloads<T>(
    sql: string,
    params: unknown[],
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(sql, params);
    return rows.map((row) => parse(JSON.parse(row.payload)));
  }

  protected async getParsedPayload<T>(
    sql: string,
    params: unknown[],
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(sql, params);
    return row ? parse(JSON.parse(row.payload)) : null;
  }
}

function sameSealedSeriesDefinition(
  left: ModelComparisonSeries,
  right: ModelComparisonSeries,
): boolean {
  const definition = (series: ModelComparisonSeries) => ({
    id: series.id,
    profileId: series.profileId,
    modelProjectId: series.modelProjectId,
    name: series.name,
    objective: series.objective,
    productionBinding: series.productionBinding,
    baseModel: series.baseModel,
    seedTaskset: series.seedTaskset,
    eligibleTaskPool: series.eligibleTaskPool,
    evaluationTasksets: series.evaluationTasksets,
    grader: series.grader,
    benchmarkProtocol: series.benchmarkProtocol,
    automaticEvaluation: series.automaticEvaluation,
    residualProfile: series.residualProfile,
    schedule: series.schedule,
    scheduleSealedAt: series.scheduleSealedAt,
    advancementPolicy: series.advancementPolicy,
    executionPolicy: series.executionPolicy,
    createdBy: series.createdBy,
    createdAt: series.createdAt,
  });
  return JSON.stringify(definition(left)) === JSON.stringify(definition(right));
}

function sameEntryLineage(
  left: ModelComparisonSeriesEntry,
  right: ModelComparisonSeriesEntry,
): boolean {
  const lineage = (entry: ModelComparisonSeriesEntry) => ({
    seriesId: entry.seriesId,
    profileId: entry.profileId,
    modelProjectId: entry.modelProjectId,
    scheduleEntryId: entry.scheduleEntryId,
    releaseHash: entry.releaseHash,
    ordinal: entry.ordinal,
    label: entry.label,
    role: entry.role,
    branch: entry.branch,
    parent: entry.parent,
    taskset: entry.taskset,
    sourceTasksets: entry.sourceTasksets,
    taskSelection: entry.taskSelection,
    trainableRank: entry.trainableRank,
    serializedEnvelopeRank: entry.serializedEnvelopeRank,
    enabledCumulativeRank: entry.enabledCumulativeRank,
    trainableBlockId: entry.trainableBlockId,
    residualBlocks: entry.residualBlocks.map(({ artifactLineageId: _artifactLineageId, ...block }) => block),
    createdAt: entry.createdAt,
  });
  return JSON.stringify(lineage(left)) === JSON.stringify(lineage(right));
}

function validEntryEvidenceEvolution(
  current: ModelComparisonSeriesEntry,
  next: ModelComparisonSeriesEntry,
): boolean {
  if (validEntryRetryEvolution(current, next)) return true;
  const appendOnlyId = (before: string | null, after: string | null) =>
    before === null || before === after;
  if (
    current.attemptOrdinal !== next.attemptOrdinal
    || JSON.stringify(current.priorRunAttempts) !== JSON.stringify(next.priorRunAttempts)
    || !appendOnlyId(current.trainingPlanId, next.trainingPlanId)
    || !appendOnlyId(current.modelRunId, next.modelRunId)
    || !appendOnlyId(current.modelVersionId, next.modelVersionId)
    || !appendOnlyId(current.promotionBindingId, next.promotionBindingId)
    || (current.decision !== null && JSON.stringify(current.decision) !== JSON.stringify(next.decision))
  ) return false;
  const nextEvaluations = new Map(next.evaluations.map((evaluation) => [evaluation.evaluationRunId, evaluation]));
  if (current.evaluations.some((evaluation) =>
    JSON.stringify(nextEvaluations.get(evaluation.evaluationRunId)) !== JSON.stringify(evaluation))) return false;
  const nextBlocks = new Map(next.residualBlocks.map((block) => [block.id, block]));
  return current.residualBlocks.every((block) => {
    if (!block.artifactLineageId) return true;
    return nextBlocks.get(block.id)?.artifactLineageId === block.artifactLineageId;
  });
}

function validEntryRetryEvolution(
  current: ModelComparisonSeriesEntry,
  next: ModelComparisonSeriesEntry,
): boolean {
  if (
    (current.status !== "failed" && current.status !== "cancelled")
    || next.status !== "ready"
    || current.modelVersionId !== null
    || current.evaluations.length !== 0
    || current.decision !== null
    || current.promotionBindingId !== null
    || current.residualBlocks.some(
      (block) => block.id === current.trainableBlockId && block.artifactLineageId !== null,
    )
    || next.trainingPlanId !== null
    || next.modelRunId !== null
    || next.modelVersionId !== null
    || next.evaluations.length !== 0
    || next.decision !== null
    || next.promotionBindingId !== null
    || next.queuedAt !== null
    || next.startedAt !== null
    || next.completedAt !== null
    || JSON.stringify(current.residualBlocks) !== JSON.stringify(next.residualBlocks)
  ) return false;
  const hasAttempt = Boolean(current.trainingPlanId || current.modelRunId);
  const expectedAttempts = hasAttempt
    ? [...current.priorRunAttempts, {
        attemptOrdinal: current.attemptOrdinal,
        trainingPlanId: current.trainingPlanId,
        modelRunId: current.modelRunId,
        terminalStatus: current.status,
        queuedAt: current.queuedAt,
        startedAt: current.startedAt,
        completedAt: current.completedAt ?? next.updatedAt,
      }]
    : current.priorRunAttempts;
  return next.attemptOrdinal === current.attemptOrdinal + (hasAttempt ? 1 : 0)
    && JSON.stringify(next.priorRunAttempts) === JSON.stringify(expectedAttempts);
}

export function isCheckpointResumeTransition(
  existing: ModelRun,
  candidate: ModelRun,
): boolean {
  if (
    existing.kind !== "evaluation"
    || !["failed", "cancelled"].includes(existing.status)
    || candidate.status !== "running"
    || candidate.receipt !== null
    || candidate.failure !== null
    || candidate.completedAt !== null
    || !existing.evaluation
  ) {
    return false;
  }
  const completedAdaptationAttempts = existing.evaluation.attemptPlan
    .filter((item) => item.stage === "baseline" || item.stage === "adaptation")
    .reduce((total, item) => total + item.attemptCount, 0);
  const completedAllAttempts = existing.evaluation.attemptPlan.reduce(
    (total, item) => total + item.attemptCount,
    0,
  );
  const candidateAdaptationPlan = existing.evaluation.attemptPlan.find(
    (item) => item.stage === "candidate_adaptation",
  );
  const completedCandidateAdaptationAttempts = completedAdaptationAttempts
    + (candidateAdaptationPlan?.attemptCount ?? 0);
  const checkpointIsDurable =
    (existing.evaluationProgress?.stage === "refiner"
      && existing.evaluationProgress.completedAttempts === completedAdaptationAttempts)
    || (existing.evaluationProgress?.stage === "candidate_adaptation"
      && existing.evaluationProgress.completedAttempts >= completedAdaptationAttempts
      && existing.evaluationProgress.completedAttempts
        <= completedCandidateAdaptationAttempts)
    || (["candidate_adaptation", "candidate", "comparison"].includes(
      existing.evaluationProgress?.stage ?? "",
    )
      && existing.evaluationProgress?.completedAttempts === completedAllAttempts);
  if (!checkpointIsDurable || !existing.evaluationProgress?.accounting) {
    return false;
  }
  return JSON.stringify({
    ...existing,
    status: "running",
    receipt: null,
    failure: null,
    completedAt: null,
    updatedAt: candidate.updatedAt,
  }) === JSON.stringify(candidate);
}
