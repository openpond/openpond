import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { DEFAULT_API_BASE_URL } from "./endpoints.js";
import { readBoundedJsonResponse } from "./protocol.js";
import {
  BeginDatasetMaterializationSchema,
  DatasetMaterializationPageQuerySchema,
  DatasetMaterializationPageSchema,
  DatasetMaterializationSchema,
  type DatasetMaterialization,
} from "./dataset-import-materialization.js";
import {
  BeginDatasetImportSchema, CancelDatasetImportSchema, CompleteDatasetImportFileSchema,
  DatasetImportFilePartPageSchema, DatasetImportFileSchema, DatasetImportPartRequestSchema,
  DatasetImportPartUrlsSchema, DatasetImportSchema, DatasetStorageSchema,
  DatasetImportPreviewQuerySchema, DatasetImportPreviewSchema,
  DatasetImportMappingReceiptSchema, SaveDatasetImportMappingSchema,
  type DatasetImportFile, type DatasetImportPart,
} from "./dataset-import-contracts.js";

const knownError = z.enum([
  "dataset_import_unavailable", "dataset_import_conflict", "dataset_import_expired",
  "dataset_storage_quota_exceeded", "dataset_import_concurrency_limit", "dataset_upload_part_invalid",
  "dataset_upload_parts_incomplete", "dataset_import_credentials_invalid", "workspace_billing_suspended",
  "dataset_import_request_invalid", "dataset_import_retry", "dataset_storage_unavailable",
  "dataset_object_hash_mismatch", "dataset_object_size_mismatch", "dataset_upload_parts_changed",
  "dataset_storage_transfer_failed", "dataset_import_request_failed",
  "dataset_mapping_revision_limit", "dataset_mapping_source_mismatch",
  "dataset_inspection_pending", "dataset_inspection_rejected_rows",
  "dataset_materialization_mapping_superseded", "dataset_materialization_family_split_conflict",
]);

export class DatasetImportRequestError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, readonly code: z.infer<typeof knownError>) {
    super(`Dataset import request failed (${status}, ${code}).`);
    this.name = "DatasetImportRequestError";
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

type RequestOptions = {
  apiKey: string;
  teamId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Dedicated transfer transport. API credentials are never attached to these requests. */
  uploadFetch?: typeof fetch;
};

function cleanHttpUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("Invalid dataset transport URL.");
  return url;
}
const partBytes = (file: DatasetImportFile, part: number) =>
  Math.max(0, Math.min(file.partSize, file.sizeBytes - (part - 1) * file.partSize));

/** A seekable source and the SHA-256 of its exact bytes. Reuse the same source
 * and operation ID to resume. Each read is bounded to one requested part. */
export interface DatasetImportSource {
  sizeBytes: number;
  sha256: string;
  read(start: number, end: number): Blob | Promise<Blob>;
}

export class OpenPondDatasetImportClient {
  private readonly baseUrl: string;
  constructor(private readonly options: RequestOptions) {
    const base = cleanHttpUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
    if (base.search || !options.apiKey.trim() || !options.teamId.trim())
      throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = base.toString().replace(/\/+$/, "");
  }

  async begin(input: z.input<typeof BeginDatasetImportSchema>, signal?: AbortSignal) {
    const request = BeginDatasetImportSchema.parse(input);
    const result = await this.request("/v1/dataset-imports", DatasetImportSchema, request, signal);
    const declared = new Map(request.files.map(file => [file.relativePath, file.sizeBytes]));
    if (result.files.length !== declared.size || result.files.some(file => {
      const match = declared.get(file.relativePath) === file.sizeBytes;
      declared.delete(file.relativePath);
      return !match;
    })) throw new Error("Dataset import receipt does not match the declared files.");
    return result;
  }

  async get(id: string, signal?: AbortSignal) {
    const value = await this.request(this.path(id), DatasetImportSchema, undefined, signal);
    if (value.importId !== id) throw new Error("Dataset import response identity mismatch.");
    return value;
  }

  async file(id: string, fileId: string, after?: string, signal?: AbortSignal) {
    if (after !== undefined && !/^[1-9][0-9]{0,4}$/u.test(after)) throw new Error("Invalid dataset upload cursor.");
    const result = await this.request(this.filePath(id, fileId) + (after ? `?after=${after}` : ""),
      DatasetImportFilePartPageSchema, undefined, signal);
    if (result.fileId !== fileId) throw new Error("Dataset import file identity mismatch.");
    return result;
  }

  async complete(id: string, fileId: string, input: z.input<typeof CompleteDatasetImportFileSchema>, signal?: AbortSignal) {
    const request = CompleteDatasetImportFileSchema.parse(input);
    const result = await this.request(`${this.filePath(id, fileId)}/complete`, DatasetImportFileSchema, request, signal);
    if (result.fileId !== fileId || (result.object && result.object.sha256 !== request.sha256))
      throw new Error("Dataset completion response identity mismatch.");
    return result;
  }

  async cancel(id: string, operationId: string, signal?: AbortSignal) {
    const value = await this.request(`${this.path(id)}/cancel`, DatasetImportSchema, CancelDatasetImportSchema.parse({ operationId }), signal);
    if (value.importId !== id) throw new Error("Dataset cancellation response identity mismatch.");
    return value;
  }

  storage(signal?: AbortSignal) {
    return this.request("/v1/dataset-storage", DatasetStorageSchema, undefined, signal);
  }

  async mapping(id: string, signal?: AbortSignal) {
    const receipt = await this.request(`${this.path(id)}/mapping`, DatasetImportMappingReceiptSchema.nullable(), undefined, signal);
    if (receipt && (receipt.importId !== id || receipt.mappingHash !==
      contentHash({ version: "openpond.datasetImportMapping.v1", groups: receipt.groups })))
      throw new Error("Dataset mapping response identity or hash mismatch.");
    return receipt;
  }

  async saveMapping(id: string, input: z.input<typeof SaveDatasetImportMappingSchema>, signal?: AbortSignal) {
    const request = SaveDatasetImportMappingSchema.parse(input);
    const receipt = await this.request(`${this.path(id)}/mapping`, DatasetImportMappingReceiptSchema, request, signal, "PUT");
    const expectedHash = contentHash({ version: "openpond.datasetImportMapping.v1", groups: request.groups });
    if (receipt.importId !== id || receipt.revision !== request.expectedRevision + 1 ||
      receipt.mappingHash !== expectedHash || receipt.mappingHash !==
      contentHash({ version: "openpond.datasetImportMapping.v1", groups: receipt.groups }))
      throw new Error("Dataset mapping response identity or hash mismatch.");
    return receipt;
  }

  /** Prepare verified shards for the pinned mapping. A ready receipt identifies
   * the staged artifacts for the subsequent dataset draft operation. */
  async materialize(id: string, input: z.input<typeof BeginDatasetMaterializationSchema>, signal?: AbortSignal) {
    const request = BeginDatasetMaterializationSchema.parse(input);
    const receipt = await this.request(`${this.path(id)}/materializations`, DatasetMaterializationSchema, request, signal);
    if (receipt.importId !== id || receipt.mappingRevision !== request.mappingRevision ||
        receipt.mappingHash !== request.mappingHash)
      throw new Error("Dataset materialization response identity mismatch.");
    this.assertMaterializationCounts(receipt);
    return receipt;
  }

  async materialization(id: string, materializationId: string, input: z.input<typeof DatasetMaterializationPageQuerySchema> = {}, signal?: AbortSignal) {
    const query = DatasetMaterializationPageQuerySchema.parse(input);
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.after) params.set("after", query.after);
    const page = await this.request(
      `${this.path(id)}/materializations/${this.pathSegment(materializationId)}?${params}`,
      DatasetMaterializationPageSchema, undefined, signal,
    );
    this.assertMaterializationCounts(page);
    const after = query.after ? Number(query.after) : 0;
    if (page.importId !== id || page.materializationId !== materializationId ||
        page.shards.length > query.limit ||
        (page.state !== "ready" && (page.shards.length || page.nextCursor)) ||
        page.shards.some((shard, index) => shard.ordinal !== after + index + 1 || shard.ordinal > page.shardCount) ||
        (page.nextCursor !== null && page.nextCursor !== String(page.shards.at(-1)?.ordinal)))
      throw new Error("Dataset shard page identity, order or bounds mismatch.");
    return page;
  }

  private assertMaterializationCounts(receipt: DatasetMaterialization) {
    const hasResult = receipt.indexHash !== null && receipt.splitCounts !== null;
    if ((receipt.state === "ready") !== hasResult ||
        (receipt.splitCounts && Object.values(receipt.splitCounts).reduce((sum, value) => sum + value, 0) !== receipt.acceptedRows))
      throw new Error("Dataset materialization counts mismatch.");
  }

  /** Read a bounded source sample and the verification-stage scan counts. */
  async preview(id: string, input: z.input<typeof DatasetImportPreviewQuerySchema>, signal?: AbortSignal) {
    const query = DatasetImportPreviewQuerySchema.parse(input);
    const params = new URLSearchParams({ fileId: query.fileId, limit: String(query.limit) });
    if (query.revision !== undefined) params.set("revision", String(query.revision));
    if (query.mappingRevision !== undefined) params.set("mappingRevision", String(query.mappingRevision));
    if (query.after) params.set("after", query.after);
    const page = await this.request(`${this.path(id)}/preview?${params}`, DatasetImportPreviewSchema, undefined, signal);
    const after = query.after ? Number(query.after) : 0;
    const lastRow = page.rows.at(-1);
    if (page.importId !== id || page.fileId !== query.fileId ||
      (query.revision !== undefined && page.revision !== query.revision) ||
      page.mappingRevision !== query.mappingRevision ||
      (page.mappingHash !== undefined) !== (query.mappingRevision !== undefined) ||
      page.rows.some(row => (row.projection !== undefined) !== (query.mappingRevision !== undefined) ||
        (row.projection?.state === "mapped" && row.projection.task.id !== row.id)) ||
      page.scannedBytes > page.sizeBytes || page.rows.length > query.limit ||
      page.previewedRows > page.acceptedRows || page.rows.length > page.previewedRows ||
      page.provisional !== (page.state !== "ready") ||
      page.totalRows !== (page.provisional ? null : page.acceptedRows + page.rejectedRows) ||
      page.rows.some((row, index) => row.ordinal <= (page.rows[index - 1]?.ordinal ?? after) ||
        row.ordinal > page.acceptedRows + page.rejectedRows) ||
      (page.nextCursor !== null && (!lastRow || page.nextCursor !== String(lastRow.ordinal))))
      throw new Error("Dataset preview response identity, order or counts mismatch.");
    return page;
  }

  /** Upload missing parts and submit verification. Use get to observe the
   * verified receipt if completion returns queued. */
  async uploadFile(
    importId: string, fileId: string, source: DatasetImportSource,
    options: { operationId: string; signal?: AbortSignal; onProgress?: (uploadedBytes: number, totalBytes: number) => void },
  ) {
    const { signal, operationId, onProgress } = options;
    if (!/^[a-f0-9]{64}$/u.test(source.sha256)) throw new Error("Provide the SHA-256 of the source file.");
    let page = await this.file(importId, fileId, undefined, signal);
    if (source.sizeBytes !== page.sizeBytes) throw new Error("Dataset source size does not match its declaration.");
    if (page.state === "verified") {
      if (page.object?.sha256 !== source.sha256) throw new Error("Dataset source does not match the verified object.");
      onProgress?.(source.sizeBytes, source.sizeBytes);
      return page;
    }
    if (page.state === "queued") return page;
    if (page.state !== "pending" && page.state !== "uploading") {
      const parsed = knownError.safeParse(page.failureCode);
      throw new DatasetImportRequestError(409, parsed.success ? parsed.data : "dataset_import_conflict");
    }

    const totalParts = Math.ceil(page.sizeBytes / page.partSize);
    if (totalParts > 10_000) throw new Error("Dataset part geometry exceeds the API limit.");
    const parts = new Map<number, DatasetImportPart>();
    let uploadedBytes = 0;
    let previousCursor = 0;
    for (;;) {
      for (const item of page.parts) {
        if (parts.has(item.partNumber) || item.sizeBytes !== partBytes(page, item.partNumber))
          throw new Error("Stored dataset part does not match the declared source.");
        parts.set(item.partNumber, { partNumber: item.partNumber, etag: item.etag });
        uploadedBytes += item.sizeBytes;
      }
      if (page.nextCursor === null) break;
      const next = Number(page.nextCursor);
      if (next <= previousCursor || next > totalParts) throw new Error("Dataset part cursor did not advance.");
      previousCursor = next;
      const result = await this.file(importId, fileId, page.nextCursor, signal);
      if (result.partSize !== page.partSize || result.sizeBytes !== page.sizeBytes || result.state !== page.state)
        throw new Error("Dataset upload changed while listing parts.");
      page = result;
    }
    onProgress?.(uploadedBytes, source.sizeBytes);
    for (let number = 1; number <= totalParts; number++) {
      if (parts.has(number)) continue;
      signal?.throwIfAborted();
      const begin = (number - 1) * page.partSize;
      const size = partBytes(page, number);
      const body = await source.read(begin, begin + size);
      if (body.size !== size) throw new Error("Dataset source changed while reading an upload part.");
      const grant = await this.request(`${this.filePath(importId, fileId)}/parts`, DatasetImportPartUrlsSchema,
        DatasetImportPartRequestSchema.parse({ partNumbers: [number] }), signal);
      const [part] = grant.parts;
      if (grant.fileId !== fileId || grant.parts.length !== 1 || part?.partNumber !== number ||
        part.sizeBytes !== size || part.headers["content-length"] !== String(size))
        throw new Error("Dataset part authorization does not match the requested part.");
      const url = cleanHttpUrl(part.url);
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Dataset transfer requires HTTPS.");
      let response: Response;
      try {
        response = await (this.options.uploadFetch ?? fetch)(url, {
          method: "PUT", body, headers: part.headers, signal, credentials: "omit", redirect: "error",
        });
      } catch {
        signal?.throwIfAborted();
        throw new DatasetImportRequestError(503, "dataset_storage_transfer_failed");
      }
      await response.body?.cancel().catch(() => undefined);
      const tag = response.headers.get("etag");
      if (!response.ok || !tag) throw new DatasetImportRequestError(response.ok ? 502 : response.status, "dataset_storage_transfer_failed");
      parts.set(number, { partNumber: number, etag: tag });
      uploadedBytes += size;
      onProgress?.(uploadedBytes, source.sizeBytes);
    }
    return this.complete(importId, fileId, {
      operationId, sha256: source.sha256,
      parts: [...parts.values()].sort((a, b) => a.partNumber - b.partNumber),
    }, signal);
  }

  private path(id: string) {
    return `/v1/dataset-imports/${this.pathSegment(id)}`;
  }

  private filePath(id: string, fileId: string) {
    return `${this.path(id)}/files/${this.pathSegment(fileId)}`;
  }

  private pathSegment(id: string) {
    if (id === "." || id === ".." || !/^[a-zA-Z0-9._:-]{1,240}$/u.test(id))
      throw new Error("Invalid dataset import identifier.");
    return encodeURIComponent(id);
  }

  private async request<S extends z.ZodType>(path: string, schema: S, body: unknown, signal?: AbortSignal, writeMethod: "POST" | "PUT" = "POST"): Promise<z.output<S>> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : writeMethod,
      redirect: "error", signal,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let code: z.infer<typeof knownError> = "dataset_import_request_failed";
      try {
        const raw = z.object({ code: knownError }).safeParse(await readBoundedJsonResponse(response, 16 * 1024, "Dataset import failure"));
        if (raw.success) code = raw.data.code;
      } catch {
        // Public failures carry a safe code and HTTP status only.
      }
      throw new DatasetImportRequestError(response.status, code);
    }
    return schema.parse(await readBoundedJsonResponse(response, 512 * 1024, "Dataset import response"));
  }
}
