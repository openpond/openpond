import {
  DatasetArtifactRegistryEntrySchema,
  DatasetImportJobSchema,
  ExternalDatasetSourceRefSchema,
  type DatasetArtifactRegistryEntry,
  type DatasetImportJob,
  type ExternalDatasetSourceRef,
  type Taskset,
} from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { now } from "../utils.js";
import { SqliteTrainingModelStore } from "./store-training-models.js";

export type DatasetCatalogTasksetProjection = {
  tasksetId: string;
  tasksetRevision: number;
  artifactId: string | null;
  name: string;
  status: Taskset["status"];
  storageKind: "inline" | "parquet";
  rowCount: number;
  splitCounts: {
    train: number;
    validation: number;
    test: number;
    frozen_eval: number;
  };
  createdAt: string;
  updatedAt: string;
};

type DatasetCatalogTasksetRow = {
  taskset_id: string;
  taskset_revision: number;
  artifact_id: string | null;
  name: string;
  status: Taskset["status"];
  storage_kind: "inline" | "parquet";
  row_count: number;
  train_count: number;
  validation_count: number;
  test_count: number;
  frozen_eval_count: number;
  created_at: string;
  updated_at: string;
};

export class SqliteDatasetStore extends SqliteTrainingModelStore {
  async listDatasetCatalogTasksets(
    profileId: string,
  ): Promise<DatasetCatalogTasksetProjection[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<DatasetCatalogTasksetRow>(
      `SELECT
         id AS taskset_id,
         CAST(json_extract(payload, '$.revision') AS INTEGER) AS taskset_revision,
         json_extract(payload, '$.datasetArtifact.id') AS artifact_id,
         json_extract(payload, '$.name') AS name,
         status,
         CASE
           WHEN json_type(payload, '$.datasetArtifact') = 'object'
             THEN 'parquet'
           ELSE 'inline'
         END AS storage_kind,
         CAST(COALESCE(
           json_extract(payload, '$.datasetArtifact.rowCount'),
           json_array_length(payload, '$.tasks'),
           0
         ) AS INTEGER) AS row_count,
         CAST(COALESCE(
           json_extract(payload, '$.datasetArtifact.splitCounts.train'),
           (SELECT COUNT(*) FROM json_each(tasksets.payload, '$.tasks')
            WHERE json_extract(value, '$.split') = 'train'),
           0
         ) AS INTEGER) AS train_count,
         CAST(COALESCE(
           json_extract(payload, '$.datasetArtifact.splitCounts.validation'),
           (SELECT COUNT(*) FROM json_each(tasksets.payload, '$.tasks')
            WHERE json_extract(value, '$.split') = 'validation'),
           0
         ) AS INTEGER) AS validation_count,
         CAST(COALESCE(
           json_extract(payload, '$.datasetArtifact.splitCounts.test'),
           (SELECT COUNT(*) FROM json_each(tasksets.payload, '$.tasks')
            WHERE json_extract(value, '$.split') = 'test'),
           0
         ) AS INTEGER) AS test_count,
         CAST(COALESCE(
           json_extract(payload, '$.datasetArtifact.splitCounts.frozen_eval'),
           (SELECT COUNT(*) FROM json_each(tasksets.payload, '$.tasks')
            WHERE json_extract(value, '$.split') = 'frozen_eval'),
           0
         ) AS INTEGER) AS frozen_eval_count,
         created_at,
         updated_at
       FROM tasksets
       WHERE profile_id = ?
       ORDER BY updated_at DESC`,
      [profileId],
    );
    return rows.map((row) => ({
      tasksetId: row.taskset_id,
      tasksetRevision: row.taskset_revision,
      artifactId: row.artifact_id,
      name: row.name,
      status: row.status,
      storageKind: row.storage_kind,
      rowCount: row.row_count,
      splitCounts: {
        train: row.train_count,
        validation: row.validation_count,
        test: row.test_count,
        frozen_eval: row.frozen_eval_count,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listExternalDatasetSources(
    profileId: string,
  ): Promise<ExternalDatasetSourceRef[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      "SELECT payload FROM training_sources WHERE profile_id = ? AND source_kind <> 'conversation' ORDER BY updated_at DESC",
      [profileId],
    );
    return rows.map((row) =>
      ExternalDatasetSourceRefSchema.parse(JSON.parse(row.payload)),
    );
  }

  async getExternalDatasetSource(
    id: string,
  ): Promise<ExternalDatasetSourceRef | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM training_sources WHERE id = ? AND source_kind <> 'conversation'",
      [id],
    );
    return row
      ? ExternalDatasetSourceRefSchema.parse(JSON.parse(row.payload))
      : null;
  }

  async upsertExternalDatasetSource(
    sourceInput: ExternalDatasetSourceRef,
  ): Promise<ExternalDatasetSourceRef> {
    const source = ExternalDatasetSourceRefSchema.parse(sourceInput);
    await this.ready;
    const timestamp = now();
    const repositoryId =
      source.kind === "huggingface" ? source.repositoryId : null;
    const revision = source.kind === "huggingface" ? source.revision : null;
    const write = this.writeQueue.then(() =>
      this.run(
        `INSERT INTO training_sources (
           id, profile_id, source_kind, session_id, source_hash,
           repository_id, revision, payload, created_at, updated_at
         )
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           profile_id = excluded.profile_id,
           source_kind = excluded.source_kind,
           session_id = NULL,
           source_hash = excluded.source_hash,
           repository_id = excluded.repository_id,
           revision = excluded.revision,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        [
          source.id,
          source.profileId,
          source.kind,
          source.sourceHash,
          repositoryId,
          revision,
          JSON.stringify(source),
          timestamp,
          timestamp,
        ],
      ),
    );
    this.writeQueue = write.catch(() => undefined);
    await write;
    return source;
  }

  async listDatasetImportJobs(profileId: string): Promise<DatasetImportJob[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM dataset_import_jobs WHERE profile_id = ? ORDER BY updated_at DESC",
      [profileId],
      DatasetImportJobSchema.parse,
    );
  }

  async listAllDatasetImportJobs(): Promise<DatasetImportJob[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM dataset_import_jobs ORDER BY updated_at DESC",
      [],
      DatasetImportJobSchema.parse,
    );
  }

  async getDatasetImportJob(id: string): Promise<DatasetImportJob | null> {
    return this.getParsedPayload(
      "SELECT payload FROM dataset_import_jobs WHERE id = ?",
      [id],
      DatasetImportJobSchema.parse,
    );
  }

  async upsertDatasetImportJob(
    jobInput: DatasetImportJob,
  ): Promise<DatasetImportJob> {
    const job = DatasetImportJobSchema.parse(jobInput);
    const repositoryId = job.locator?.repositoryId ?? null;
    const revision =
      job.inspection?.resolvedRevision
      ?? job.locator?.requestedRevision
      ?? null;
    await this.upsertPayload(
      `INSERT INTO dataset_import_jobs (
         id, profile_id, source_kind, status, repository_id, revision,
         taskset_id, payload, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         profile_id = excluded.profile_id,
         source_kind = excluded.source_kind,
         status = excluded.status,
         repository_id = excluded.repository_id,
         revision = excluded.revision,
         taskset_id = excluded.taskset_id,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        job.id,
        job.profileId,
        job.sourceKind,
        job.status,
        repositoryId,
        revision,
        job.tasksetId,
        JSON.stringify(job),
        job.createdAt,
        job.updatedAt,
      ],
    );
    return job;
  }

  async listDatasetArtifactRegistryEntries(
    profileId: string,
  ): Promise<DatasetArtifactRegistryEntry[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM dataset_artifacts WHERE profile_id = ? ORDER BY updated_at DESC",
      [profileId],
      DatasetArtifactRegistryEntrySchema.parse,
    );
  }

  async getDatasetArtifactRegistryEntry(
    id: string,
  ): Promise<DatasetArtifactRegistryEntry | null> {
    return this.getParsedPayload(
      "SELECT payload FROM dataset_artifacts WHERE id = ?",
      [id],
      DatasetArtifactRegistryEntrySchema.parse,
    );
  }

  async getDatasetArtifactForTaskset(
    tasksetId: string,
    revision?: number | null,
  ): Promise<DatasetArtifactRegistryEntry | null> {
    const params: unknown[] = revision
      ? [tasksetId, revision]
      : [tasksetId];
    const sql = revision
      ? "SELECT payload FROM dataset_artifacts WHERE taskset_id = ? AND taskset_revision = ?"
      : "SELECT payload FROM dataset_artifacts WHERE taskset_id = ? ORDER BY taskset_revision DESC LIMIT 1";
    return this.getParsedPayload(
      sql,
      params,
      DatasetArtifactRegistryEntrySchema.parse,
    );
  }

  async upsertDatasetArtifactRegistryEntry(
    entryInput: DatasetArtifactRegistryEntry,
  ): Promise<DatasetArtifactRegistryEntry> {
    const entry = DatasetArtifactRegistryEntrySchema.parse(entryInput);
    const manifest = entry.manifest;
    await this.upsertPayload(
      `INSERT INTO dataset_artifacts (
         id, profile_id, taskset_id, taskset_revision, content_hash,
         format, row_count, storage_root, payload, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         profile_id = excluded.profile_id,
         taskset_id = excluded.taskset_id,
         taskset_revision = excluded.taskset_revision,
         content_hash = excluded.content_hash,
         format = excluded.format,
         row_count = excluded.row_count,
         storage_root = excluded.storage_root,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        manifest.id,
        entry.profileId,
        manifest.tasksetId,
        manifest.tasksetRevision,
        manifest.contentHash,
        manifest.format,
        manifest.rowCount,
        entry.storageRoot,
        JSON.stringify(entry),
        entry.createdAt,
        entry.updatedAt,
      ],
    );
    return entry;
  }
}
