import { randomUUID } from "node:crypto";
import {
  HuggingFaceDatasetInspectionSchema,
  HuggingFaceDatasetLocatorSchema,
  type DatasetImportMapping,
  type DatasetSourceColumn,
  type HuggingFaceDatasetInspection,
  type HuggingFaceDatasetLocator,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

const HUB_HOSTS = new Set(["huggingface.co", "www.huggingface.co"]);
const METADATA_LIMIT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

export function normalizeHuggingFaceDatasetLocator(
  input: string,
): HuggingFaceDatasetLocator {
  const value = input.trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) {
    return HuggingFaceDatasetLocatorSchema.parse({
      schemaVersion: "openpond.huggingFaceDatasetLocator.v1",
      repositoryId: value.replace(/\.git$/i, ""),
      repositoryUrl: `https://huggingface.co/datasets/${value.replace(/\.git$/i, "")}`,
      requestedRevision: null,
    });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Enter a Hugging Face Dataset URL or an organization/dataset repository ID.",
    );
  }
  if (
    url.protocol !== "https:"
    || !HUB_HOSTS.has(url.hostname.toLowerCase())
    || url.username
    || url.password
  ) {
    throw new Error("Only credential-free https://huggingface.co Dataset URLs are supported.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "datasets" || !segments[1] || !segments[2]) {
    throw new Error("The URL must point to a Hugging Face Dataset repository.");
  }
  const repositoryId = `${decodeURIComponent(segments[1])}/${decodeURIComponent(segments[2]).replace(/\.git$/i, "")}`;
  const treeIndex = segments.indexOf("tree");
  const requestedRevision =
    treeIndex >= 0 && segments[treeIndex + 1]
      ? decodeURIComponent(segments.slice(treeIndex + 1).join("/"))
      : null;
  return HuggingFaceDatasetLocatorSchema.parse({
    schemaVersion: "openpond.huggingFaceDatasetLocator.v1",
    repositoryId,
    repositoryUrl: `https://huggingface.co/datasets/${repositoryId}`,
    requestedRevision,
  });
}

export async function inspectHuggingFaceDataset(
  locatorInput: HuggingFaceDatasetLocator,
  request: typeof fetch = fetch,
): Promise<HuggingFaceDatasetInspection> {
  const locator = HuggingFaceDatasetLocatorSchema.parse(locatorInput);
  const revisionSuffix = locator.requestedRevision
    ? `/revision/${encodeURIComponent(locator.requestedRevision)}`
    : "";
  const repository = await fetchJson(
    request,
    `https://huggingface.co/api/datasets/${locator.repositoryId}${revisionSuffix}`,
  );
  const resolvedRevision = requiredString(repository.sha, "resolved Dataset revision");
  const gated = repository.gated === true || typeof repository.gated === "string";
  const privateRepository = repository.private === true;
  if (gated || privateRepository) {
    throw new Error(
      gated
        ? "This gated Dataset requires an approved Hugging Face credential before inspection."
        : "This private Dataset requires a Hugging Face credential before inspection.",
    );
  }
  const splitsResult = await fetchJson(
    request,
    `https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(locator.repositoryId)}`,
  );
  const rawSplits = Array.isArray(splitsResult.splits)
    ? splitsResult.splits.flatMap(datasetSplit)
    : [];
  if (!rawSplits.length) {
    throw new Error(
      "Hugging Face could not expose an inspectable configuration and split for this Dataset.",
    );
  }
  const configurations = [...new Set(rawSplits.map((split) => split.configuration))];
  const selected = rawSplits[0]!;
  const [firstRows, sizes, parquetResult, parquetRevision] = await Promise.all([
    fetchJson(
      request,
      `https://datasets-server.huggingface.co/first-rows?dataset=${encodeURIComponent(locator.repositoryId)}&config=${encodeURIComponent(selected.configuration)}&split=${encodeURIComponent(selected.split)}`,
    ),
    fetchJson(
      request,
      `https://datasets-server.huggingface.co/size?dataset=${encodeURIComponent(locator.repositoryId)}`,
    ).catch(() => ({})),
    fetchJson(
      request,
      `https://datasets-server.huggingface.co/parquet?dataset=${encodeURIComponent(locator.repositoryId)}`,
    ),
    fetchJson(
      request,
      `https://huggingface.co/api/datasets/${locator.repositoryId}/revision/${encodeURIComponent("refs/convert/parquet")}`,
    ),
  ]);
  const previewRows = Array.isArray(firstRows.rows)
    ? firstRows.rows.slice(0, 25).flatMap((value) => {
        const record = asRecord(value);
        return record && asRecord(record.row) ? [record.row as Record<string, unknown>] : [];
      })
    : [];
  const columns = sourceColumns(firstRows.features, previewRows);
  const sizeBySplit = datasetSizeBySplit(sizes);
  const splits = rawSplits.map((split) => ({
    ...split,
    ...(sizeBySplit.get(`${split.configuration}\n${split.split}`) ?? {
      rowCount: null,
      sizeBytes: null,
    }),
  }));
  if (
    parquetResult.partial === true
    || (Array.isArray(parquetResult.pending) && parquetResult.pending.length)
    || (Array.isArray(parquetResult.failed) && parquetResult.failed.length)
  ) {
    throw new Error(
      "Hugging Face has not produced a complete Parquet projection for this Dataset.",
    );
  }
  const parquetRevisionSha = requiredString(
    parquetRevision.sha,
    "resolved Dataset Parquet revision",
  );
  const sourceFiles = Array.isArray(parquetResult.parquet_files)
    ? parquetResult.parquet_files.flatMap((value) =>
        parquetSourceFile(value, locator.repositoryId, parquetRevisionSha))
    : [];
  if (!sourceFiles.length) {
    throw new Error(
      "Hugging Face did not expose any complete Parquet files for this Dataset.",
    );
  }
  const cardData = asRecord(repository.cardData);
  const tags = Array.isArray(repository.tags)
    ? repository.tags.filter((value): value is string => typeof value === "string")
    : [];
  const declaredLicense =
    typeof cardData?.license === "string"
      ? cardData.license
      : tags.find((tag) => tag.startsWith("license:"))?.slice("license:".length)
        ?? null;
  const title =
    typeof cardData?.pretty_name === "string"
      ? cardData.pretty_name
      : locator.repositoryId.split("/").at(-1)!;
  return HuggingFaceDatasetInspectionSchema.parse({
    schemaVersion: "openpond.huggingFaceDatasetInspection.v1",
    id: `dataset_inspection_${randomUUID()}`,
    locator,
    resolvedRevision,
    title,
    description:
      typeof cardData?.description === "string" ? cardData.description : null,
    declaredLicense,
    gated,
    private: privateRepository,
    configurations,
    splits,
    columns,
    previewRows,
    sourceFiles,
    inspectedAt: new Date().toISOString(),
    metadata: {
      sourceSchemaHash: contentHash(
        columns.map(({ path, logicalType, nullable }) => ({
          path,
          logicalType,
          nullable,
        })),
      ),
      suggestedMapping: suggestMapping(columns),
      downloads: typeof repository.downloads === "number" ? repository.downloads : null,
      likes: typeof repository.likes === "number" ? repository.likes : null,
      usedStorage: typeof repository.usedStorage === "number" ? repository.usedStorage : null,
      parquetRevision: parquetRevisionSha,
    },
  });
}

export function suggestedHuggingFaceMapping(
  inspection: HuggingFaceDatasetInspection,
): Omit<DatasetImportMapping, "mappingHash"> {
  const suggestion = asRecord(inspection.metadata.suggestedMapping);
  const bindings = Array.isArray(suggestion?.bindings)
    ? suggestion.bindings
    : [];
  const sourceSchemaHash =
    typeof inspection.metadata.sourceSchemaHash === "string"
      ? inspection.metadata.sourceSchemaHash
      : contentHash(inspection.columns);
  return {
    schemaVersion: "openpond.datasetImportMapping.v1",
    sourceSchemaHash,
    configuration: inspection.splits[0]!.configuration,
    upstreamSplits: inspection.splits
      .filter((split) => split.configuration === inspection.splits[0]!.configuration)
      .map((split) => split.split),
    preset:
      suggestion?.preset === "prompt_expected_answer"
        ? "prompt_expected_answer"
        : suggestion?.preset === "prompt_completion"
          ? "prompt_completion"
          : "prompt_only",
    bindings: bindings as DatasetImportMapping["bindings"],
    nullPolicy: "drop",
    invalidRowPolicy: "drop_with_receipt",
    splitPolicy: {
      seed: 17,
      assignments: Object.fromEntries(
        inspection.splits.map((split) => [
          split.split,
          split.split === "test"
            ? "frozen_eval" as const
            : split.split === "validation"
              ? "validation" as const
              : "train" as const,
        ]),
      ),
      validationPercent: inspection.splits.some((split) => split.split === "validation") ? 0 : 5,
      frozenEvalPercent: inspection.splits.some((split) => split.split === "test") ? 0 : 5,
    },
    importerVersion: "openpond-huggingface-v1",
  };
}

export function huggingFaceResolveUrl(
  repositoryId: string,
  revision: string,
  file: string,
): string {
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/datasets/${repositoryId}/resolve/${encodeURIComponent(revision)}/${encodedFile}`;
}

function parquetSourceFile(
  value: unknown,
  repositoryId: string,
  revision: string,
): Array<{
  path: string;
  configuration: string;
  split: string;
  revision: string;
  sizeBytes: number | null;
  contentHash: null;
}> {
  const item = asRecord(value);
  if (
    item?.dataset !== repositoryId
    || typeof item.config !== "string"
    || typeof item.split !== "string"
    || typeof item.filename !== "string"
    || !item.filename.toLowerCase().endsWith(".parquet")
  ) {
    return [];
  }
  const path = [item.config, item.split, item.filename]
    .flatMap((segment) => segment.split("/"))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  if (!path || path.split("/").includes("..")) return [];
  return [{
    path,
    configuration: item.config,
    split: item.split,
    revision,
    sizeBytes:
      typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0
        ? item.size
        : null,
    contentHash: null,
  }];
}

function suggestMapping(columns: DatasetSourceColumn[]): Record<string, unknown> {
  const paths = new Set(columns.map((column) => column.path));
  const promptPath = firstPresent(paths, ["prompt", "messages", "question", "input", "instruction"]);
  const expectedPath = firstPresent(paths, [
    "reward_model.ground_truth",
    "answer",
    "expected_output",
    "output",
    "completion",
    "response",
  ]);
  const rowIdPath = firstPresent(paths, [
    "extra_info.index",
    "id",
    "row_id",
    "index",
  ]);
  const bindings: DatasetImportMapping["bindings"] = [];
  if (rowIdPath) {
    bindings.push({
      sourcePath: rowIdPath,
      target: "row_id",
      transform: "string",
      policy: "metadata",
      required: false,
    });
  }
  if (promptPath) {
    bindings.push({
      sourcePath: promptPath,
      target: promptPath === "prompt" || promptPath === "messages" ? "messages" : "prompt",
      transform: promptPath === "prompt" || promptPath === "messages" ? "messages" : "string",
      policy: "visible",
      required: true,
    });
  }
  if (expectedPath) {
    bindings.push({
      sourcePath: expectedPath,
      target: expectedPath === "completion" || expectedPath === "response"
        ? "demonstration"
        : "expected_output",
      transform: expectedPath.includes("ground_truth") ? "math_final_answer" : "string",
      policy: expectedPath === "completion" || expectedPath === "response"
        ? "privileged"
        : "privileged",
      required: true,
    });
  }
  return {
    preset: expectedPath?.includes("ground_truth") || expectedPath === "answer"
      ? "prompt_expected_answer"
      : expectedPath ? "prompt_completion" : "prompt_only",
    bindings,
  };
}

function sourceColumns(features: unknown, rows: Record<string, unknown>[]): DatasetSourceColumn[] {
  const sample = rows[0] ?? {};
  const paths = new Map<string, { type: string; nullable: boolean; values: unknown[] }>();
  flattenRecord(sample, "", paths, rows);
  if (!paths.size && Array.isArray(features)) {
    for (const value of features) {
      const item = asRecord(value);
      if (typeof item?.name !== "string") continue;
      paths.set(item.name, {
        type: JSON.stringify(item.type ?? "unknown").slice(0, 500),
        nullable: true,
        values: [],
      });
    }
  }
  return [...paths.entries()].map(([path, value]) => ({
    path,
    logicalType: value.type,
    nullable: value.nullable,
    sampleValues: value.values.slice(0, 5),
  }));
}

function flattenRecord(
  value: unknown,
  prefix: string,
  paths: Map<string, { type: string; nullable: boolean; values: unknown[] }>,
  rows: Record<string, unknown>[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) {
      paths.set(prefix, {
        type: logicalType(value),
        nullable: rows.some((row) => nestedValue(row, prefix) == null),
        values: rows.map((row) => nestedValue(row, prefix)).filter((item) => item != null),
      });
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenRecord(child, path, paths, rows);
    } else {
      paths.set(path, {
        type: logicalType(child),
        nullable: rows.some((row) => nestedValue(row, path) == null),
        values: rows.map((row) => nestedValue(row, path)).filter((item) => item != null),
      });
    }
  }
}

function nestedValue(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[segment];
  }
  return current;
}

function logicalType(value: unknown): string {
  if (Array.isArray(value)) return value.every((item) => asRecord(item)?.role && asRecord(item)?.content) ? "messages" : "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function datasetSplit(value: unknown): Array<{
  configuration: string;
  split: string;
  rowCount: number | null;
  sizeBytes: number | null;
}> {
  const item = asRecord(value);
  return typeof item?.config === "string" && typeof item.split === "string"
    ? [{
        configuration: item.config,
        split: item.split,
        rowCount: null,
        sizeBytes: null,
      }]
    : [];
}

function datasetSizeBySplit(
  value: Record<string, unknown>,
): Map<string, { rowCount: number | null; sizeBytes: number | null }> {
  const size = asRecord(value.size);
  const splits = Array.isArray(size?.splits) ? size.splits : [];
  return new Map(splits.flatMap((value) => {
    const item = asRecord(value);
    if (typeof item?.config !== "string" || typeof item.split !== "string") return [];
    return [[`${item.config}\n${item.split}`, {
      rowCount: typeof item.num_rows === "number" ? item.num_rows : null,
      sizeBytes: typeof item.num_bytes_parquet_files === "number"
        ? item.num_bytes_parquet_files
        : null,
    }]];
  }));
}

async function fetchJson(
  request: typeof fetch,
  url: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await request(url, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Hugging Face inspection failed (${response.status}).`);
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null
      ? null
      : Number(contentLengthHeader);
    if (
      contentLength !== null
      && Number.isFinite(contentLength)
      && contentLength > METADATA_LIMIT_BYTES
    ) {
      throw new Error("Hugging Face inspection metadata exceeded its byte limit.");
    }
    if (!response.body) {
      throw new Error("Hugging Face returned empty inspection metadata.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > METADATA_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error(
          "Hugging Face inspection metadata exceeded its byte limit.",
        );
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const record = asRecord(parsed);
    if (!record) throw new Error("Hugging Face returned invalid inspection metadata.");
    return record;
  } finally {
    clearTimeout(timeout);
  }
}

function firstPresent(paths: Set<string>, candidates: string[]): string | null {
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Hugging Face did not return a ${label}.`);
  }
  return value.trim();
}
