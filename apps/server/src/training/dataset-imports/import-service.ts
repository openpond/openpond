import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  DatasetArtifactRegistryEntrySchema,
  DatasetImportJobSchema,
  DatasetImportMappingSchema,
  HuggingFaceDatasetSourceRefSchema,
  type DatasetImportJob,
  type DatasetImportMapping,
  type DatasetImportProgress,
  type Taskset,
} from "@openpond/contracts";
import {
  canonicalJson,
  contentHash,
} from "@openpond/taskset-sdk";
import type { SqliteStore } from "../../store/store.js";
import {
  huggingFaceResolveUrl,
  inspectHuggingFaceDataset,
  normalizeHuggingFaceDatasetLocator,
  suggestedHuggingFaceMapping,
} from "./hugging-face.js";
import {
  buildImportedDatasetManifest,
  buildImportedDatasetTaskset,
} from "./imported-taskset.js";
import {
  assertDatasetImportNotCancelled,
  assertDatasetStorageCapacity,
  downloadDatasetFile,
  installVerifiedDatasetBlob,
  parseDatasetMaterializeResult,
  runDatasetMaterializeWorker,
  selectedDatasetSourceRows,
  sumKnownDatasetBytes,
  verifyDatasetFile,
} from "./materialize-worker.js";

const LICENSES_REQUIRING_EXPLICIT_REVIEW = new Set([
  "unknown",
  "other",
]);

export function createDatasetImportService(deps: {
  store: SqliteStore;
  workerProjectDir: string;
  datasetStorageRoot: () => Promise<string | null>;
  request?: typeof fetch;
}) {
  const request = deps.request ?? fetch;
  const controllers = new Map<string, AbortController>();

  async function persistProgress(
    job: DatasetImportJob,
    next: DatasetImportProgress,
    status: DatasetImportJob["status"] = job.status,
  ): Promise<DatasetImportJob> {
    const updated = DatasetImportJobSchema.parse({
      ...job,
      status,
      progress: next,
      updatedAt: new Date().toISOString(),
    });
    await deps.store.upsertDatasetImportJob(updated);
    return updated;
  }

  async function inspectHuggingFace(input: {
    profileId: string;
    url: string;
  }): Promise<DatasetImportJob> {
    const timestamp = new Date().toISOString();
    const locator = normalizeHuggingFaceDatasetLocator(input.url);
    let job = DatasetImportJobSchema.parse({
      schemaVersion: "openpond.datasetImportJob.v1",
      id: `dataset_import_${randomUUID()}`,
      profileId: input.profileId,
      sourceKind: "huggingface",
      status: "inspecting",
      locator,
      inspection: null,
      mapping: null,
      progress: progress("metadata", "Inspecting the pinned Dataset source."),
      targetStorageRoot: null,
      tasksetId: null,
      tasksetRevision: null,
      artifactId: null,
      error: null,
      cancellationRequested: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      metadata: {},
    });
    await deps.store.upsertDatasetImportJob(job);
    try {
      const inspection = await inspectHuggingFaceDataset(locator, request);
      const suggested = finalizeMapping(
        suggestedHuggingFaceMapping(inspection),
      );
      job = DatasetImportJobSchema.parse({
        ...job,
        status: "awaiting_mapping",
        inspection,
        mapping: suggested,
        progress: progress("idle", "Review the detected fields and split policy."),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      job = failedJob(job, error);
    }
    return deps.store.upsertDatasetImportJob(job);
  }

  async function materialize(input: {
    id: string;
    name: string;
    objective: string;
    mapping: unknown;
    targetStorageRoot?: string | null;
    licenseApproved?: boolean;
  }): Promise<DatasetImportJob> {
    const current = await requireJob(input.id);
    if (
      current.status !== "awaiting_mapping"
      && current.status !== "awaiting_materialization_approval"
      && current.status !== "failed"
      && current.status !== "ready"
    ) {
      throw new Error(`Dataset import ${current.id} cannot materialize from ${current.status}.`);
    }
    if (!current.inspection || !current.locator) {
      throw new Error("Inspect the Hugging Face Dataset before materialization.");
    }
    const mapping = finalizeMapping(input.mapping);
    const expectedSchemaHash = current.inspection.metadata.sourceSchemaHash;
    if (
      typeof expectedSchemaHash !== "string"
      || mapping.sourceSchemaHash !== expectedSchemaHash
    ) {
      throw new Error("The approved mapping does not match the inspected source schema.");
    }
    const targetStorageRoot =
      input.targetStorageRoot
      ?? current.targetStorageRoot
      ?? await deps.datasetStorageRoot();
    if (!targetStorageRoot) {
      throw new Error(
        "Choose a Dataset storage folder in Settings > Dataset Storage before importing.",
      );
    }
    const existingTaskset = current.tasksetId
      ? await deps.store.getTaskset(current.tasksetId)
      : null;
    const controller = new AbortController();
    controllers.set(current.id, controller);
    const timestamp = new Date().toISOString();
    const queued = DatasetImportJobSchema.parse({
      ...current,
      status: "materializing",
      mapping,
      targetStorageRoot: path.resolve(targetStorageRoot),
      tasksetId: current.tasksetId ?? safeTasksetId(input.name, current.id),
      tasksetRevision:
        current.status === "ready"
          ? (existingTaskset?.revision ?? current.tasksetRevision ?? 0) + 1
          : current.tasksetRevision ?? 1,
      error: null,
      cancellationRequested: false,
      progress: progress("download", "Preparing verified source files."),
      updatedAt: timestamp,
      metadata: {
        ...current.metadata,
        requestedName: input.name,
        requestedObjective: input.objective,
        licenseApproved: input.licenseApproved === true,
      },
    });
    await deps.store.upsertDatasetImportJob(queued);
    void runMaterialization(
      queued,
      input.name,
      input.objective,
      controller,
      existingTaskset,
    )
      .finally(() => controllers.delete(queued.id));
    return queued;
  }

  async function cancel(id: string): Promise<DatasetImportJob> {
    const current = await requireJob(id);
    if (["ready", "failed", "cancelled"].includes(current.status)) return current;
    controllers.get(id)?.abort();
    const updated = DatasetImportJobSchema.parse({
      ...current,
      status: controllers.has(id) ? "cancelling" : "cancelled",
      cancellationRequested: true,
      updatedAt: new Date().toISOString(),
      completedAt: controllers.has(id) ? null : new Date().toISOString(),
      progress: progress("idle", "Cancelling Dataset import."),
    });
    return deps.store.upsertDatasetImportJob(updated);
  }

  async function reconcile(): Promise<void> {
    const active = (await allImportJobs()).filter((job) =>
      ["inspecting", "materializing", "validating", "cancelling"].includes(job.status),
    );
    for (const job of active) {
      await deps.store.upsertDatasetImportJob(
        DatasetImportJobSchema.parse({
          ...job,
          status: "failed",
          error:
            "OpenPond restarted during Dataset import. The pinned source and approved mapping were preserved; retry materialization to continue.",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          progress: progress("idle", "Import paused after restart."),
        }),
      );
    }
  }

  async function runMaterialization(
    initial: DatasetImportJob,
    name: string,
    objective: string,
    controller: AbortController,
    existingTaskset: Taskset | null,
  ): Promise<void> {
    let job = initial;
    const inspection = job.inspection!;
    const mapping = job.mapping!;
    const configuredRoot = path.resolve(job.targetStorageRoot!);
    const stagingRoot = path.join(configuredRoot, "staging", job.id);
    const sourceStaging = path.join(stagingRoot, "source");
    const materializedStaging = path.join(stagingRoot, "materialized");
    const finalRoot = path.join(
      configuredRoot,
      "tasksets",
      job.tasksetId!,
      String(job.tasksetRevision),
    );
    try {
      const selectedSourceFiles = inspection.sourceFiles.filter(
        (sourceFile) =>
          sourceFile.configuration === mapping.configuration
          && mapping.upstreamSplits.includes(sourceFile.split),
      );
      if (!selectedSourceFiles.length) {
        throw new Error(
          "The approved configuration and splits have no pinned Parquet files.",
        );
      }
      if (selectedSourceFiles.some((sourceFile) => sourceFile.sizeBytes === null)) {
        throw new Error(
          "Hugging Face did not declare a verifiable size for every selected Parquet file.",
        );
      }
      await assertDatasetStorageCapacity(configuredRoot, selectedSourceFiles);
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(sourceStaging, { recursive: true });
      const totalBytes = sumKnownDatasetBytes(selectedSourceFiles);
      let completedBytes = 0;
      const reusableFiles = reusableSourceFiles(
        existingTaskset,
        configuredRoot,
      );
      const verifiedFiles: Array<{
        sourcePath: string;
        configuration: string;
        upstreamSplit: string;
        revision: string;
        blobPath: string;
        contentHash: string;
        sizeBytes: number;
      }> = [];
      for (const [index, sourceFile] of selectedSourceFiles.entries()) {
        assertDatasetImportNotCancelled(controller.signal);
        const reusable = reusableFiles.get(
          `${sourceFile.configuration}:${sourceFile.split}:${sourceFile.path}:${sourceFile.revision}`,
        );
        if (
          reusable
          && await verifyDatasetFile({
            path: reusable.blobPath,
            expectedSizeBytes: reusable.sizeBytes,
            expectedContentHash: reusable.contentHash,
          })
        ) {
          completedBytes += reusable.sizeBytes;
          verifiedFiles.push(reusable);
          job = await persistProgress(job, {
            phase: "download",
            completedBytes,
            totalBytes,
            completedRows: 0,
            totalRows: selectedDatasetSourceRows(inspection, mapping),
            message: `Reusing verified ${sourceFile.path}`,
          });
          continue;
        }
        const temporary = path.join(sourceStaging, `${index}.parquet.partial`);
        const result = await downloadDatasetFile({
          request,
          url: huggingFaceResolveUrl(
            inspection.locator.repositoryId,
            sourceFile.revision,
            sourceFile.path,
          ),
          destination: temporary,
          expectedSizeBytes: sourceFile.sizeBytes!,
          signal: controller.signal,
          onProgress: async (bytes) => {
            completedBytes += bytes;
            job = await persistProgress(job, {
              phase: "download",
              completedBytes,
              totalBytes,
              completedRows: 0,
              totalRows: selectedDatasetSourceRows(inspection, mapping),
              message: `Downloading ${sourceFile.path}`,
            });
          },
        });
        const relativeBlob = path.join(
          "blobs",
          "sha256",
          result.contentHash.slice(0, 2),
          result.contentHash,
        );
        const blobPath = path.join(configuredRoot, relativeBlob);
        await mkdir(path.dirname(blobPath), { recursive: true });
        await installVerifiedDatasetBlob({
          temporaryPath: temporary,
          blobPath,
          expectedSizeBytes: result.sizeBytes,
          expectedContentHash: result.contentHash,
        });
        verifiedFiles.push({
          sourcePath: sourceFile.path,
          configuration: sourceFile.configuration,
          upstreamSplit: sourceFile.split,
          revision: sourceFile.revision,
          blobPath,
          contentHash: result.contentHash,
          sizeBytes: result.sizeBytes,
        });
      }
      const sourceHash = contentHash({
        repositoryId: inspection.locator.repositoryId,
        revision: inspection.resolvedRevision,
        files: verifiedFiles.map(({
          sourcePath,
          configuration,
          upstreamSplit,
          revision,
          contentHash,
          sizeBytes,
        }) => ({
          sourcePath,
          configuration,
          upstreamSplit,
          revision,
          contentHash,
          sizeBytes,
        })),
      });
      const sourceId = `dataset_source_${sourceHash.slice(0, 24)}`;
      await mkdir(materializedStaging, { recursive: true });
      const controlPath = path.join(stagingRoot, "materialize-control.json");
      const resultPath = path.join(stagingRoot, "materialize-result.json");
      await writeFile(
        controlPath,
        canonicalJson({
          schemaVersion: "openpond.datasetMaterializeControl.v1",
          outputRoot: materializedStaging,
          files: verifiedFiles.map((file) => ({
            path: file.blobPath,
            upstreamSplit: file.upstreamSplit,
          })),
          sourceId,
          sourceHash,
          mapping,
          shardRows: 100_000,
          rowGroupRows: 10_000,
          previewRows: 25,
        }),
        "utf8",
      );
      job = await persistProgress(job, {
        phase: "mapping",
        completedBytes,
        totalBytes,
        completedRows: 0,
        totalRows: selectedDatasetSourceRows(inspection, mapping),
        message: "Mapping source rows into canonical Parquet shards.",
      });
      await runDatasetMaterializeWorker({
        projectDir: deps.workerProjectDir,
        controlPath,
        resultPath,
        signal: controller.signal,
        onProgress: async (event) => {
          const completedRows =
            typeof event.completedRows === "number" ? event.completedRows : 0;
          job = await persistProgress(job, {
            phase: event.phase === "verification" ? "verification" : "parquet_write",
            completedBytes,
            totalBytes,
            completedRows,
            totalRows: selectedDatasetSourceRows(inspection, mapping),
            message:
              event.phase === "verification"
                ? "Verifying Parquet shards."
                : "Writing canonical Parquet shards.",
          });
        },
      });
      assertDatasetImportNotCancelled(controller.signal);
      const result = parseDatasetMaterializeResult(
        JSON.parse(await readFile(resultPath, "utf8")),
      );
      job = await persistProgress(job, {
        phase: "verification",
        completedBytes,
        totalBytes,
        completedRows: result.rowCount,
        totalRows: result.rowCount,
        message: "Registering the immutable Dataset artifact.",
      }, "validating");
      const source = HuggingFaceDatasetSourceRefSchema.parse({
        schemaVersion: "openpond.huggingFaceDatasetSource.v1",
        kind: "huggingface",
        id: sourceId,
        profileId: job.profileId,
        title: inspection.title,
        sourceHash,
        occurredAt: inspection.inspectedAt,
        licensingStatus: approvedLicenseStatus(
          inspection.declaredLicense,
          job.metadata.licenseApproved === true,
        ),
        secretScanStatus: "passed",
        piiScanStatus: "passed",
        repositoryId: inspection.locator.repositoryId,
        repositoryUrl: inspection.locator.repositoryUrl,
        revision: inspection.resolvedRevision,
        configuration: mapping.configuration,
        upstreamSplits: mapping.upstreamSplits,
        gated: inspection.gated,
        private: inspection.private,
        declaredLicense: inspection.declaredLicense,
        licenseApproved: job.metadata.licenseApproved === true,
        sourceFileHashes: verifiedFiles.map((file) => file.contentHash),
        metadata: {
          importJobId: job.id,
          mappingHash: mapping.mappingHash,
          sourceFiles: verifiedFiles.map(({
            sourcePath,
            configuration,
            upstreamSplit,
            revision,
            contentHash,
            sizeBytes,
          }) => ({
            sourcePath,
            configuration,
            upstreamSplit,
            revision,
            contentHash,
            sizeBytes,
          })),
        },
      });
      if (source.licensingStatus !== "approved") {
        throw new Error(
          "The Dataset license requires an explicit approval decision before materialization.",
        );
      }
      const manifest = buildImportedDatasetManifest(job, mapping, result);
      const taskset = buildImportedDatasetTaskset({
        job,
        name,
        objective,
        source,
        manifest,
        result,
      });
      const receipt = {
        schemaVersion: "openpond.datasetImportReceipt.v1",
        id: manifest.sourceReceiptRefs[0],
        importJobId: job.id,
        repositoryId: inspection.locator.repositoryId,
        repositoryUrl: inspection.locator.repositoryUrl,
        revision: inspection.resolvedRevision,
        configuration: mapping.configuration,
        upstreamSplits: mapping.upstreamSplits,
        declaredLicense: inspection.declaredLicense,
        mappingHash: mapping.mappingHash,
        sourceHash,
        sourceFiles: verifiedFiles.map(({
          sourcePath,
          configuration,
          upstreamSplit,
          revision,
          contentHash,
          sizeBytes,
        }) => ({
          sourcePath,
          configuration,
          upstreamSplit,
          revision,
          contentHash,
          sizeBytes,
        })),
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(materializedStaging, "dataset-manifest.json"),
        canonicalJson(manifest),
        "utf8",
      );
      await writeFile(
        path.join(materializedStaging, "taskset.json"),
        canonicalJson(taskset),
        "utf8",
      );
      await writeFile(
        path.join(materializedStaging, "receipt.json"),
        canonicalJson(receipt),
        "utf8",
      );
      await writeFile(
        path.join(materializedStaging, "mapping.json"),
        canonicalJson(mapping),
        "utf8",
      );
      await writeFile(
        path.join(materializedStaging, "quality-report.json"),
        canonicalJson(result.qualityReport),
        "utf8",
      );
      await mkdir(path.dirname(finalRoot), { recursive: true });
      await rm(finalRoot, { recursive: true, force: true });
      await rename(materializedStaging, finalRoot);
      await deps.store.upsertExternalDatasetSource(source);
      await deps.store.upsertTaskset(taskset);
      const registry = DatasetArtifactRegistryEntrySchema.parse({
        schemaVersion: "openpond.datasetArtifactRegistry.v1",
        manifest,
        profileId: job.profileId,
        storageRoot: finalRoot,
        relativeManifestPath: "dataset-manifest.json",
        available: true,
        unavailableReason: null,
        verifiedAt: new Date().toISOString(),
        createdAt: taskset.createdAt,
        updatedAt: taskset.updatedAt,
      });
      await deps.store.upsertDatasetArtifactRegistryEntry(registry);
      const complete = DatasetImportJobSchema.parse({
        ...job,
        status: "ready",
        tasksetId: taskset.id,
        tasksetRevision: taskset.revision,
        artifactId: manifest.id,
        progress: {
          phase: "publish",
          completedBytes,
          totalBytes,
          completedRows: result.rowCount,
          totalRows: result.rowCount,
          message: "Dataset saved.",
        },
        error: null,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      await deps.store.upsertDatasetImportJob(complete);
      await rm(stagingRoot, { recursive: true, force: true });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      await deps.store.upsertDatasetImportJob(
        DatasetImportJobSchema.parse({
          ...job,
          status: cancelled ? "cancelled" : "failed",
          cancellationRequested: cancelled,
          error: cancelled ? null : errorMessage(error),
          progress: progress(
            "idle",
            cancelled ? "Dataset import cancelled." : "Dataset import failed.",
          ),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      );
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async function requireJob(id: string): Promise<DatasetImportJob> {
    const job = await deps.store.getDatasetImportJob(id);
    if (!job) throw new Error("Dataset import not found.");
    return job;
  }

  async function allImportJobs(): Promise<DatasetImportJob[]> {
    return deps.store.listAllDatasetImportJobs();
  }

  return { cancel, inspectHuggingFace, materialize, reconcile };
}

function reusableSourceFiles(
  taskset: Taskset | null,
  configuredRoot: string,
): Map<string, {
  sourcePath: string;
  configuration: string;
  upstreamSplit: string;
  revision: string;
  blobPath: string;
  contentHash: string;
  sizeBytes: number;
}> {
  const result = new Map<string, {
    sourcePath: string;
    configuration: string;
    upstreamSplit: string;
    revision: string;
    blobPath: string;
    contentHash: string;
    sizeBytes: number;
  }>();
  for (const source of taskset?.sourceRefs ?? []) {
    const files = Array.isArray(source.metadata.sourceFiles)
      ? source.metadata.sourceFiles
      : [];
    for (const value of files) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const file = value as Record<string, unknown>;
      if (
        typeof file.sourcePath !== "string"
        || typeof file.configuration !== "string"
        || typeof file.upstreamSplit !== "string"
        || typeof file.revision !== "string"
        || typeof file.contentHash !== "string"
        || !Number.isSafeInteger(file.sizeBytes)
      ) {
        continue;
      }
      const blobPath = path.join(
        configuredRoot,
        "blobs",
        "sha256",
        file.contentHash.slice(0, 2),
        file.contentHash,
      );
      const reusable = {
        sourcePath: file.sourcePath,
        configuration: file.configuration,
        upstreamSplit: file.upstreamSplit,
        revision: file.revision,
        blobPath,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes as number,
      };
      result.set(
        `${reusable.configuration}:${reusable.upstreamSplit}:${reusable.sourcePath}:${reusable.revision}`,
        reusable,
      );
    }
  }
  return result;
}

function finalizeMapping(input: unknown): DatasetImportMapping {
  const record = asRecord(input);
  if (!record) throw new Error("Dataset mapping is required.");
  const base = { ...record, mappingHash: "00000000" };
  const parsed = DatasetImportMappingSchema.parse(base);
  const { mappingHash: _ignored, ...hashable } = parsed;
  return DatasetImportMappingSchema.parse({
    ...hashable,
    mappingHash: contentHash(hashable),
  });
}

function progress(
  phase: DatasetImportProgress["phase"],
  message: string,
): DatasetImportProgress {
  return {
    phase,
    completedBytes: 0,
    totalBytes: null,
    completedRows: 0,
    totalRows: null,
    message,
  };
}

function failedJob(job: DatasetImportJob, error: unknown): DatasetImportJob {
  return DatasetImportJobSchema.parse({
    ...job,
    status: "failed",
    error: errorMessage(error),
    progress: progress("idle", "Dataset inspection failed."),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
}

function approvedLicenseStatus(
  license: string | null,
  explicitlyApproved: boolean,
): "approved" | "review" {
  if (explicitlyApproved) return "approved";
  if (!license || LICENSES_REQUIRING_EXPLICIT_REVIEW.has(license.toLowerCase())) {
    return "review";
  }
  return "approved";
}

function safeTasksetId(name: string, jobId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "dataset";
  return `taskset_${slug}_${contentHash(jobId).slice(0, 12)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
