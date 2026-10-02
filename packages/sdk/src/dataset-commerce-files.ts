import { z } from "zod";
import { CommerceHash, CommerceId, CommerceOperation } from "./dataset-commerce-contracts.js";
import { CommerceCapturedReleaseSchema } from "./dataset-commerce-responses.js";

export const CommerceFileMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/)
      .refine((name) => !name.includes("..")),
    format: z.enum(["csv", "jsonl", "parquet"]),
    contentHash: CommerceHash,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict();
export const PrepareCommerceFileSchema = CommerceOperation.extend({
  file: CommerceFileMetadataSchema,
}).strict();
export const CaptureCommerceFileSchema = z
  .object({
    uploadId: CommerceId,
    capture: CommerceOperation.extend({
      expectedHash: CommerceHash,
      sampleTaskIds: z.array(CommerceId).min(1).max(10),
      approvedSample: z.literal(true),
    }).strict(),
  })
  .strict();
export const CommerceFilePreviewSchema = CommerceFileMetadataSchema.extend({
  rowCount: z.number().int().nonnegative().max(10_000_000),
  columns: z.array(z.string()).max(256),
  rows: z
    .array(z.object({ taskId: CommerceId, input: z.record(z.string(), z.unknown()) }).strict())
    .max(50),
}).strict();
const Ticket = z
  .object({ uploadId: CommerceId, uploadUrl: z.string().url(), expiresAt: z.string().datetime() })
  .strict();
type Options = { signal?: AbortSignal };
type Transport = (path: string, options: Options, input: unknown) => Promise<unknown>;

/** Metadata travels through the API; bytes go only to its scoped, short-lived object-store URL. */
export class OpenPondCommerceFiles {
  constructor(
    private readonly request: Transport,
    private readonly fetcher: typeof globalThis.fetch,
  ) {}
  async prepare(input: z.infer<typeof PrepareCommerceFileSchema>, options: Options = {}) {
    const value = PrepareCommerceFileSchema.parse(input);
    if (!value.file.name.toLowerCase().endsWith(`.${value.file.format}`))
      throw new Error("Filename must match the dataset format.");
    const result = Ticket.parse(await this.request("/prepare-file", options, value));
    const url = new URL(result.uploadUrl);
    if (
      result.uploadId !== value.operationId ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      new Date(result.expiresAt).getTime() <= Date.now()
    )
      throw new Error("Dataset upload ticket does not match this operation.");
    return result;
  }
  async preview(uploadId: string, options: Options = {}) {
    return CommerceFilePreviewSchema.parse(
      await this.request("/preview-file", options, { uploadId: CommerceId.parse(uploadId) }),
    );
  }
  async capture(input: z.infer<typeof CaptureCommerceFileSchema>, options: Options = {}) {
    const value = CaptureCommerceFileSchema.parse(input);
    const result = CommerceCapturedReleaseSchema.parse(
      await this.request("/capture-file", options, value),
    );
    if (
      result.packageHash !== value.capture.expectedHash ||
      result.sample.length !== new Set(value.capture.sampleTaskIds).size ||
      result.sample.some((row) => !value.capture.sampleTaskIds.includes(row.taskId))
    )
      throw new Error("Captured file does not match the approved preview.");
    return result;
  }
  async upload(
    input: {
      operationId: string;
      name: string;
      format: "csv" | "jsonl" | "parquet";
      bytes: Uint8Array;
    },
    options: Options = {},
  ) {
    // Copy once so caller mutation cannot change bytes between hashing and upload.
    const bytes = Uint8Array.from(input.bytes);
    if (!bytes.length || bytes.length > 16 * 1024 * 1024)
      throw new Error("Choose a nonempty dataset file up to 16 MiB.");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const contentHash = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const file = { name: input.name, format: input.format, contentHash, sizeBytes: bytes.length };
    const ticket = await this.prepare({ operationId: input.operationId, file }, options);
    const response = await this.fetcher(ticket.uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "application/octet-stream" },
      redirect: "error",
      credentials: "omit",
      signal: options.signal,
    });
    if (!response.ok)
      throw new Error(
        `Private dataset upload failed (${response.status}). Retry with the same operation ID.`,
      );
    const preview = await this.preview(ticket.uploadId, options);
    if (
      preview.contentHash !== contentHash ||
      preview.sizeBytes !== bytes.length ||
      preview.name !== input.name ||
      preview.format !== input.format
    )
      throw new Error("Uploaded dataset preview does not match the supplied file.");
    return { uploadId: ticket.uploadId, preview };
  }
}
