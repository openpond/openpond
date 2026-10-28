import { z } from "zod";
import {
  OPENPOND_TRAINING_MEDIA_TYPE,
  TRAINING_API_RESPONSE_MAX_BYTES,
  OpenPondProtocolError,
  readBoundedJsonResponse,
} from "./protocol.js";

export const TrainingApiErrorSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingApiError.v2"),
    code: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5_000),
    retryable: z.boolean().default(false),
    requestId: z.string().trim().min(1).max(500).nullable().default(null),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export class OpenPondTrainingApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;

  constructor(status: number, error: z.infer<typeof TrainingApiErrorSchema>) {
    super(error.message);
    this.name = "OpenPondTrainingApiError";
    this.status = status;
    this.code = error.code;
    this.retryable = error.retryable;
    this.requestId = error.requestId;
    this.details = error.details;
  }
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export type TrainingTransportOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
};
export function createTrainingRequest(input: TrainingTransportOptions) {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");

  async function request(
    pathname: string,
    init?: RequestInit,
    responseLimit = TRAINING_API_RESPONSE_MAX_BYTES,
  ): Promise<unknown> {
    const readOnly = init?.method === undefined || init.method.toUpperCase() === "GET";
    const maximumAttempts = readOnly ? 3 : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let response: Response;
      try {
        const configuredHeaders =
          typeof input.headers === "function" ? await input.headers() : (input.headers ?? {});
        response = await fetchImpl(`${baseUrl}${pathname}`, {
          ...init,
          headers: {
            accept: OPENPOND_TRAINING_MEDIA_TYPE,
            ...(init?.body ? { "content-type": OPENPOND_TRAINING_MEDIA_TYPE } : {}),
            ...headersRecord(configuredHeaders),
            ...headersRecord(init?.headers),
          },
        });
      } catch (error) {
        if (
          attempt === maximumAttempts ||
          init?.signal?.aborted ||
          !trainingReadFailureIsRetryable(null, error)
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        continue;
      }
      const body = await readBoundedJsonResponse(response, responseLimit, "Training API response");
      if (response.ok) return body;
      const error = trainingApiError(body, response.status);
      if (attempt === maximumAttempts || !trainingReadFailureIsRetryable(response.status, error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
    throw new OpenPondProtocolError(
      "training_read_retry_exhausted",
      "Training read retry loop exhausted without a response.",
    );
  }

  return request;
}

function trainingReadFailureIsRetryable(status: number | null, error: unknown): boolean {
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }
  if (error instanceof OpenPondTrainingApiError) return error.retryable;
  if (error instanceof OpenPondProtocolError) {
    return error.code === "invalid_error_response";
  }
  return error instanceof TypeError;
}

function trainingApiError(value: unknown, status: number): Error {
  const parsed = TrainingApiErrorSchema.safeParse(value);
  if (parsed.success) {
    return new OpenPondTrainingApiError(status, parsed.data);
  }
  return new OpenPondProtocolError(
    "invalid_error_response",
    `Training request failed with HTTP ${status} and an invalid error envelope.`,
  );
}
