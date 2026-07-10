const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_API_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LONG_STREAM_API_OPTIONS = { timeoutMs: 15 * 60 * 1000, maxResponseBytes: 64 * 1024 * 1024 } as const;

export type ApiFetchOptions = RequestInit & {
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export class ApiTimeoutError extends Error {
  readonly code = "OPENPOND_API_TIMEOUT";

  constructor(readonly timeoutMs: number, readonly requestUrl: string) {
    super(`API request timed out after ${timeoutMs}ms: ${requestUrl}`);
    this.name = "ApiTimeoutError";
  }
}

export class ApiResponseTooLargeError extends Error {
  readonly code = "OPENPOND_API_RESPONSE_TOO_LARGE";

  constructor(readonly maximumBytes: number, readonly requestUrl: string) {
    super(`API response exceeded ${maximumBytes} bytes: ${requestUrl}`);
    this.name = "ApiResponseTooLargeError";
  }
}

export async function apiFetch(
  baseUrl: string,
  token: string | null,
  requestPath: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_API_TIMEOUT_MS, maxResponseBytes = DEFAULT_API_RESPONSE_BYTES, ...init } = options;
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  const apiKey = process.env.OPENPOND_API_KEY;
  const trimmedToken = token?.trim() || "";
  const tokenIsApiKey = trimmedToken.startsWith("opk_");
  const effectiveApiKey = apiKey || (tokenIsApiKey ? trimmedToken : null);
  if (effectiveApiKey && !headers.has("openpond-api-key")) headers.set("openpond-api-key", effectiveApiKey);
  if (token) {
    headers.set("Authorization", tokenIsApiKey ? `ApiKey ${trimmedToken}` : `Bearer ${token}`);
  } else if (apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `ApiKey ${apiKey}`);
  }

  const requestUrl = `${baseUrl}${requestPath}`;
  const timeoutController = new AbortController();
  const timeoutError = new ApiTimeoutError(timeoutMs, requestUrl);
  const timer = timeoutMs > 0
    ? setTimeout(() => timeoutController.abort(timeoutError), timeoutMs)
    : null;
  timer?.unref?.();
  const signal = composedSignal(init.signal, timeoutController.signal, timeoutMs);
  const cleanup = () => {
    if (timer) clearTimeout(timer);
  };

  try {
    const response = await fetch(requestUrl, { ...init, headers, signal });
    return boundedResponse(response, {
      cleanup,
      maximumBytes: maxResponseBytes,
      requestUrl,
      timeoutController,
      timeoutError,
    });
  } catch (error) {
    cleanup();
    if (timeoutController.signal.aborted) throw timeoutError;
    throw error;
  }
}

export async function readApiJson<T>(response: Response, label: string): Promise<T> {
  let payload: T & { error?: unknown; message?: unknown };
  try {
    const text = await response.text();
    payload = (text ? JSON.parse(text) : {}) as T & { error?: unknown; message?: unknown };
  } catch (error) {
    if (error instanceof ApiTimeoutError || error instanceof ApiResponseTooLargeError) throw error;
    payload = {} as T & { error?: unknown; message?: unknown };
  }
  if (!response.ok) {
    const message = typeof payload.message === "string"
      ? payload.message
      : typeof payload.error === "string"
        ? payload.error
        : "";
    throw new Error(`${label} failed: ${response.status}${message ? ` ${message}` : ""}`);
  }
  return payload as T;
}

function boundedResponse(
  response: Response,
  input: {
    cleanup: () => void;
    maximumBytes: number;
    requestUrl: string;
    timeoutController: AbortController;
    timeoutError: ApiTimeoutError;
  },
): Response {
  if (!response.body) {
    input.cleanup();
    return response;
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (input.maximumBytes > 0 && Number.isFinite(contentLength) && contentLength > input.maximumBytes) {
    input.cleanup();
    void response.body.cancel();
    throw new ApiResponseTooLargeError(input.maximumBytes, input.requestUrl);
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          input.cleanup();
          controller.close();
          return;
        }
        receivedBytes += result.value.byteLength;
        if (input.maximumBytes > 0 && receivedBytes > input.maximumBytes) {
          input.cleanup();
          await reader.cancel();
          controller.error(new ApiResponseTooLargeError(input.maximumBytes, input.requestUrl));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        input.cleanup();
        controller.error(input.timeoutController.signal.aborted ? input.timeoutError : error);
      }
    },
    async cancel(reason) {
      input.cleanup();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function composedSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) return callerSignal ?? undefined;
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}
