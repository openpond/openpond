import { z } from "zod";
import { TaskDataRecordSchema, TasksetSplitSchema } from "./taskset-draft-core.js";

const id = z.string().min(1).max(240).regex(/^[a-zA-Z0-9._:-]+$/u);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const partNumber = z.number().int().min(1).max(10_000);
const etag = z.string().regex(/^"[^"\p{Cc}\p{White_Space}]{1,128}"$/u);
const relativePath = z.string().min(1).max(500).refine(path =>
  path.normalize("NFC") === path && !/[\\:\p{Cc}]/u.test(path) &&
  path.split("/").every(part => part !== "" && part !== "." && part !== ".."),
);
const source = z.object({ relativePath, sizeBytes: bytes.positive() }).strict();
const part = z.object({ partNumber, etag }).strict();
const uploadState = z.enum(["pending", "uploading", "queued", "verified", "failed", "deleted"]);

export const BeginDatasetImportSchema = z.object({
  operationId: id,
  files: z.array(source).min(1).max(100),
}).strict().refine(value => new Set(value.files.map(file => file.relativePath)).size === value.files.length);
export const DatasetImportPartRequestSchema = z.object({
  partNumbers: z.array(partNumber).min(1).max(50),
}).strict().refine(value => new Set(value.partNumbers).size === value.partNumbers.length);
export const CompleteDatasetImportFileSchema = z.object({
  operationId: id, sha256: hash, parts: z.array(part).min(1).max(10_000),
}).strict().refine(value => value.parts.every((entry, index) => entry.partNumber === index + 1));
export const CancelDatasetImportSchema = z.object({ operationId: id }).strict();

const object = z.object({
  objectId: id, sha256: hash, sizeBytes: bytes.positive(),
  mediaType: z.string().min(1).max(240), visibility: z.literal("private_source"),
}).strict();
export const DatasetImportFileSchema = source.extend({
  fileId: id, partSize: bytes.positive(),
  state: uploadState,
  failureCode: id.nullable(), object: object.nullable(),
}).strict().superRefine((file, context) => {
  if ((file.state === "verified") !== (file.object !== null) ||
    (file.object && (file.object.objectId !== file.fileId || file.object.sizeBytes !== file.sizeBytes)))
    context.addIssue({ code: "custom", message: "Dataset source object identity mismatch." });
});
export const DatasetImportSchema = z.object({
  importId: id, state: z.enum(["uploading", "uploaded", "attached", "cancelling", "cancelled"]),
  reservedBytes: bytes, expiresAt: z.iso.datetime(),
  files: z.array(DatasetImportFileSchema).min(1).max(100),
}).strict();
// The file receipt and its part cursor share a response object.
export const DatasetImportFilePartPageSchema = z.looseObject({
  parts: z.array(part.extend({ sizeBytes: bytes.positive() })).max(100),
  nextCursor: z.string().regex(/^[1-9][0-9]{0,4}$/u).nullable(),
}).transform(({ parts, nextCursor, ...file }) => ({ ...DatasetImportFileSchema.parse(file), parts, nextCursor }));

export const DatasetImportPartUrlsSchema = z.object({
  fileId: id,
  parts: z.array(z.object({
    partNumber, sizeBytes: bytes.positive(), url: z.string().max(8192),
    headers: z.object({ "content-length": z.string().regex(/^[1-9][0-9]*$/u) }).strict(),
  }).strict()).min(1).max(50),
}).strict();
export const DatasetStorageSchema = z.object({
  allowanceBytes: bytes, retainedBytes: bytes, reservedBytes: bytes, availableBytes: bytes,
  higherLimits: z.discriminatedUnion("action", [
    z.object({ action: z.literal("request") }).strict(),
    z.object({
      action: z.literal("add_credits"),
      additionalPaidCreditUsd: z.string().regex(/^\d+\.\d{6}$/u),
    }).strict(),
    z.object({ action: z.literal("contact_billing_admin") }).strict(),
  ]).optional(),
}).strict();

const fieldName = z.string().min(1).max(200).regex(/^[^\p{Cc}]+$/u);
const fieldPath = z.array(fieldName).min(1).max(12);
const column = z.object({ name: fieldName, path: fieldPath }).strict();
const uniqueColumnNames = (columns: Array<z.infer<typeof column>>) =>
  new Set(columns.map(entry => entry.name)).size === columns.length;
const selectedFiles = z.array(id).min(1).max(100);

export const DatasetImportMappingGroupsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sources"), fileIds: selectedFiles }).strict(),
  z.object({
    kind: z.literal("tasks"),
    fileIds: selectedFiles,
    input: z.array(column).min(1).max(24).refine(uniqueColumnNames),
    reference: fieldPath.optional(),
    context: z.array(column).max(24).refine(uniqueColumnNames).optional(),
    family: fieldPath.optional(),
    split: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("fixed"), value: TasksetSplitSchema }).strict(),
      z.object({ kind: z.literal("column"), path: fieldPath }).strict(),
    ]),
  }).strict().refine(group => {
    const reference = group.reference;
    if (!reference) return true;
    return [...group.input, ...(group.context ?? [])].every(({ path }) =>
      path.slice(0, reference.length).some((segment, index) => segment !== reference[index]));
  }, "Keep the reference field separate from policy-visible inputs and context."),
])).min(1).max(100).refine(groups => {
  const files = groups.flatMap(group => group.fileIds);
  return files.length <= 100 && new Set(files).size === files.length;
});

export const SaveDatasetImportMappingSchema = z.object({
  operationId: id,
  expectedRevision: z.number().int().min(0).max(128),
  groups: DatasetImportMappingGroupsSchema,
}).strict();

export const DatasetImportMappingReceiptSchema = z.object({
  importId: id, revision: bytes.positive().max(128), mappingHash: hash,
  groups: DatasetImportMappingGroupsSchema,
}).strict();

const projection = z.discriminatedUnion("state", [
  z.object({ state: z.literal("mapped"), task: TaskDataRecordSchema }).strict(),
  z.object({ state: z.literal("rejected"), code: id }).strict(),
  z.object({ state: z.literal("source") }).strict(),
  z.object({ state: z.literal("excluded") }).strict(),
]);

export const DatasetImportPreviewQuerySchema = z.object({
  fileId: id,
  revision: bytes.positive().optional(),
  mappingRevision: bytes.positive().optional(),
  after: z.string().regex(/^[1-9]\d{0,15}$/u).refine(cursor => Number.isSafeInteger(Number(cursor))).optional(),
  limit: z.number().int().min(1).max(64).default(20),
}).strict().refine(query => query.after === undefined || query.revision !== undefined);

export const DatasetImportPreviewSchema = z.object({
  importId: id, fileId: id, relativePath, sizeBytes: bytes.positive(), uploadState,
  revision: bytes.positive().nullable(),
  state: z.enum(["waiting_for_upload", "queued", "inspecting", "ready", "failed", "unsupported"]),
  format: z.enum(["csv", "json", "jsonl"]).nullable(),
  scannedBytes: bytes, acceptedRows: bytes, rejectedRows: bytes, totalRows: bytes.nullable(),
  provisional: z.boolean(), previewedRows: z.number().int().min(0).max(64), failureCode: id.nullable(),
  mappingRevision: bytes.positive().optional(), mappingHash: hash.optional(),
  rows: z.array(z.object({
    id: hash, ordinal: bytes.positive(), values: z.record(z.string(), z.unknown()),
    projection: projection.optional(),
  }).strict()).max(64),
  nextCursor: DatasetImportPreviewQuerySchema.shape.after.unwrap().nullable(),
}).strict();

export type DatasetImport = z.infer<typeof DatasetImportSchema>;
export type DatasetImportFile = z.infer<typeof DatasetImportFileSchema>;
export type DatasetImportPart = z.infer<typeof part>;
export type DatasetImportPreview = z.infer<typeof DatasetImportPreviewSchema>;
export type DatasetImportMappingReceipt = z.infer<typeof DatasetImportMappingReceiptSchema>;
