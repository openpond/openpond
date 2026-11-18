import { z } from "zod";

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
  state: z.enum(["pending", "uploading", "queued", "verified", "failed", "deleted"]),
  failureCode: id.nullable(), object: object.nullable(),
}).strict().superRefine((file, context) => {
  if ((file.state === "verified") !== (file.object !== null) ||
    (file.object && (file.object.objectId !== file.fileId || file.object.sizeBytes !== file.sizeBytes)))
    context.addIssue({ code: "custom", message: "Dataset source object identity mismatch." });
});
export const DatasetImportSchema = z.object({
  importId: id, state: z.enum(["uploading", "uploaded", "cancelling", "cancelled"]),
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

export type DatasetImport = z.infer<typeof DatasetImportSchema>;
export type DatasetImportFile = z.infer<typeof DatasetImportFileSchema>;
export type DatasetImportPart = z.infer<typeof part>;
