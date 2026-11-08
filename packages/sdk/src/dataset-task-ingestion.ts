import { DEFAULT_API_BASE_URL } from "./endpoints.js";
import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { readBoundedJsonResponse } from "./protocol.js";

const Id = z.string().trim().min(1).max(240);
export const DatasetTaskInputSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    input: z.record(z.string(), z.unknown()),
    expectedOutput: z.record(z.string(), z.unknown()).nullable().default(null),
    split: z.enum(["train", "validation", "frozen_eval"]).default("validation"),
    source: z
      .object({
        kind: z.string().trim().min(1).max(100),
        eventId: Id.optional(),
        label: z.string().trim().min(1).max(300).optional(),
        occurredAt: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
    tags: z.array(Id).max(100).default([]),
  })
  .strict();
export const DatasetTaskAppendRequestSchema = z
  .object({
    schemaVersion: z.literal("openpond.datasetTaskAppend.v1"),
    operationId: Id,
    task: DatasetTaskInputSchema,
  })
  .strict();
export const DatasetTaskAppendReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.datasetTaskReceipt.v1"),
    teamId: Id,
    datasetId: z.string().trim().min(1).max(240),
    taskId: Id,
    operationId: Id,
    receivedAt: z.iso.datetime(),
    revision: z.number().int().positive(),
    state: z.literal("saved"),
    trainingUseAuthorized: z.literal(false),
  })
  .strict();
/** Source identity, distinct from the server's canonical taskId. */
export type DatasetTaskInput = z.input<typeof DatasetTaskInputSchema> & { id?: string };
export type DatasetTaskAppendReceipt = z.infer<typeof DatasetTaskAppendReceiptSchema>;
export type AddTaskOptions = {
  /** Prefer task.id. Retained for existing callers; conflicting IDs are rejected. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export type DatasetTaskClientOptions = {
  apiKey: string;
  baseUrl?: string;
  teamId: string;
  fetch?: typeof fetch;
};

export class DatasetTaskIngestionError extends Error {
  readonly outcomeUnknown: boolean;
  /** Reuse this source ID when retrying an uncertain submission. */
  readonly sourceId: string;
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly operationId: string,
  ) {
    super(message);
    this.name = "DatasetTaskIngestionError";
    this.sourceId = operationId;
    this.outcomeUnknown =
      status === 0 || status === 408 || status >= 500 || code === "dataset_task_receipt_invalid";
  }
}

/** A bounded append, independent of complete workspace downloads or replacement. */
export async function addDatasetTask(
  config: DatasetTaskClientOptions,
  datasetId: string,
  task: DatasetTaskInput,
  options: AddTaskOptions = {},
): Promise<DatasetTaskAppendReceipt> {
  const url = new URL(config.baseUrl ?? DEFAULT_API_BASE_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("A clean API origin is required.");
  const teamId = Id.parse(config.teamId);
  if (!config.apiKey.trim()) throw new Error("An OpenPond API key is required.");
  const id = z.string().trim().min(1).max(240).parse(datasetId);
  const { id: sourceId, ...content } = task;
  if (
    sourceId !== undefined &&
    options.idempotencyKey !== undefined &&
    sourceId !== options.idempotencyKey
  )
    throw new Error("task.id and idempotencyKey must identify the same source event.");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300_000)
  )
    throw new Error("timeoutMs must be greater than zero and at most 300000.");
  const request = DatasetTaskAppendRequestSchema.parse({
    schemaVersion: "openpond.datasetTaskAppend.v1",
    operationId: sourceId ?? options.idempotencyKey ?? crypto.randomUUID(),
    task: content,
  });
  assertBoundedTaskJson(request, 128 * 1024);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(
      `${url.origin}/v1/dataset-workspaces/${encodeURIComponent(id)}/tasks`,
      {
        method: "POST",
        redirect: "error",
        signal:
          options.timeoutMs === undefined
            ? options.signal
            : AbortSignal.any([
                AbortSignal.timeout(options.timeoutMs),
                ...(options.signal ? [options.signal] : []),
              ]),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-OpenPond-Team-Id": teamId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
  } catch {
    throw new DatasetTaskIngestionError(
      "Task delivery could not be confirmed. Retry with the same operation ID.",
      0,
      "dataset_task_outcome_unknown",
      request.operationId,
    );
  }
  // HTTP rejection establishes a known outcome even when its error body is malformed.
  let raw: unknown;
  try {
    raw = await readBoundedJsonResponse(response, 64 * 1024, "Dataset task receipt");
  } catch {
    throw new DatasetTaskIngestionError(
      "Task delivery returned an invalid receipt. Retain the same operation ID before retrying.",
      response.status,
      response.ok ? "dataset_task_receipt_invalid" : "dataset_task_request_failed",
      request.operationId,
    );
  }
  if (!response.ok) {
    const error = z
      .object({ message: z.string().optional(), code: z.string().optional() })
      .passthrough()
      .safeParse(raw);
    throw new DatasetTaskIngestionError(
      error.success ? (error.data.message ?? "Task submission failed.") : "Task submission failed.",
      response.status,
      error.success
        ? (error.data.code ?? "dataset_task_request_failed")
        : "dataset_task_request_failed",
      request.operationId,
    );
  }
  const parsed = DatasetTaskAppendReceiptSchema.safeParse(raw);
  if (!parsed.success)
    throw new DatasetTaskIngestionError(
      "Task delivery returned an invalid receipt.",
      response.status,
      "dataset_task_receipt_invalid",
      request.operationId,
    );
  const receipt = parsed.data;
  if (
    receipt.teamId !== teamId ||
    receipt.datasetId !== id ||
    receipt.operationId !== request.operationId
  )
    throw new DatasetTaskIngestionError(
      "Dataset task receipt identity mismatch.",
      response.status,
      "dataset_task_receipt_invalid",
      request.operationId,
    );
  return receipt;
}

/** Bind credentials and destination once; the returned addTask has no global state. */
export function createTaskAdder(config: DatasetTaskClientOptions & { datasetId: string }) {
  const { datasetId, ...connection } = config;
  return (task: DatasetTaskInput, options?: AddTaskOptions) =>
    addDatasetTask(connection, datasetId, task, options);
}
