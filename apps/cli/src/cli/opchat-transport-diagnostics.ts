import type { HostedChatStreamDiagnostic } from "../hosted-chat";

const ERROR_NAMES = new Set([
  "Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError",
  "SocketError", "HeadersTimeoutError", "BodyTimeoutError", "ConnectTimeoutError",
]);
const ERROR_CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_ABORTED", "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED", "UND_ERR_RESPONSE_STATUS_CODE", "ECONNRESET", "ECONNREFUSED",
  "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR",
]);

/** Never copy cause messages, stacks, socket addresses or arbitrary properties. */
export function boundedTransportError(error: unknown) {
  const causes: Array<{ name: string; code: string | null }> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && causes.length < 3 && !seen.has(current)) {
    seen.add(current);
    const value = current as { name?: unknown; code?: unknown; cause?: unknown };
    causes.push({
      name: typeof value.name === "string" && ERROR_NAMES.has(value.name) ? value.name : "unrecognized",
      code: value.code === undefined ? null
        : typeof value.code === "string" && ERROR_CODES.has(value.code) ? value.code : "unrecognized",
    });
    current = value.cause;
  }
  return causes;
}

/** Fixed-size counters survive a failed stream without retaining its contents. */
export function createStreamDiagnostics() {
  let requestStarted: number | null = null;
  let headers: Extract<HostedChatStreamDiagnostic, { type: "headers" }> | null = null;
  let firstByteAtMs: number | null = null;
  let lastByteAtMs: number | null = null;
  let lastDataAtMs: number | null = null;
  let lastCommentAtMs: number | null = null;
  let maxByteGapMs = 0;
  let bytes = 0;
  let readChunks = 0;
  let dataFrames = 0;
  let commentFrames = 0;
  let errorFrames = 0;
  let doneAtMs: number | null = null;

  const observe = (event: HostedChatStreamDiagnostic) => {
    if (event.type === "request") requestStarted = performance.now() - event.elapsedMs;
    if (event.type === "headers") headers = event;
    if (event.type === "bytes") {
      maxByteGapMs = Math.max(maxByteGapMs, event.elapsedMs - (lastByteAtMs ?? headers?.elapsedMs ?? 0));
      firstByteAtMs ??= event.elapsedMs;
      lastByteAtMs = event.elapsedMs;
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + event.byteLength);
      readChunks = Math.min(Number.MAX_SAFE_INTEGER, readChunks + 1);
    }
    if (event.type === "data") {
      dataFrames = Math.min(Number.MAX_SAFE_INTEGER, dataFrames + 1);
      lastDataAtMs = event.elapsedMs;
      if (event.errorFrame) errorFrames = Math.min(Number.MAX_SAFE_INTEGER, errorFrames + 1);
    }
    if (event.type === "comment") {
      commentFrames = Math.min(Number.MAX_SAFE_INTEGER, commentFrames + 1);
      lastCommentAtMs = event.elapsedMs;
    }
    if (event.type === "done") doneAtMs = event.elapsedMs;
  };

  const snapshot = () => {
    const elapsedMs = requestStarted === null ? null : Math.round(performance.now() - requestStarted);
    return {
      phase: requestStarted === null ? "not_started" : !headers ? "before_headers"
        : doneAtMs !== null ? "done" : errorFrames > 0 ? "error_frame" : "response_body",
      elapsedMs,
      response: headers === null ? null : {
        status: headers.status, headersAtMs: headers.elapsedMs,
        eventStream: headers.eventStream, noCache: headers.noCache,
        noTransform: headers.noTransform, bufferingDisabled: headers.bufferingDisabled,
      },
      bytes, readChunks, dataFrames, commentFrames, errorFrames,
      firstByteAtMs, lastByteAtMs, lastDataAtMs, lastCommentAtMs, doneAtMs,
      maxByteGapMs,
      silentForMs: elapsedMs === null || headers === null ? null
        : Math.max(0, elapsedMs - (lastByteAtMs ?? headers.elapsedMs)),
    };
  };
  return { observe, snapshot };
}
