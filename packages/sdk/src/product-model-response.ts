import { ProductModelError } from "./product-model-wire.js";

/** Bound response bodies for both model consumers and require the
 * personalized gateway's terminal marker before treating EOF as completion. */
export function boundProductModelResponse(response: Response, context: {
  signal?: AbortSignal; requestId?: string; clientRequestId?: string;
} = {}): Response {
  const headers = new Headers(response.headers);
  if (context.clientRequestId) headers.set("x-openpond-client-request-id", context.clientRequestId);
  if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers });
  const streaming = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0,
    pending = "",
    terminal = false;
  let identity: { id: string; model: string } | undefined;
  const fail = () =>
    new ProductModelError(
      streaming ? "model_stream_interrupted" : "model_response_invalid",
      response.status,
      true,
      context.requestId ?? response.headers.get("x-openpond-request-id") ??
        response.headers.get("x-request-id") ??
        undefined,
      context.clientRequestId,
    );
  let closed = false;
  let cancellation: Promise<void> | undefined;
  // Abort, parser failure and consumer cancellation may converge. One owner
  // cancels the source and releases its reader only after pending reads settle.
  const cancelReader = (reason?: unknown) => cancellation ??= reader.cancel(reason)
    .finally(() => reader.releaseLock());
  let abort: (() => void) | undefined;
  const cleanup = () => { if (abort) context.signal?.removeEventListener("abort", abort); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        closed = true;
        cleanup();
        void cancelReader().catch(() => {});
        controller.error(fail());
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      if (context.signal?.aborted) abort();
    },
    async pull(controller) {
      if (closed) return;
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          if (streaming && !terminal) throw fail();
          closed = true;
          cleanup();
          controller.close();
          reader.releaseLock();
          return;
        }
        total += value.byteLength;
        if (total > 8 * 1024 * 1024) throw fail();
        if (streaming) {
          pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            if (new TextEncoder().encode(frame).length > 1024 * 1024) throw fail();
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data === "[DONE]") terminal = true;
            else if (data) {
              const chunk = JSON.parse(data);
              if (typeof chunk.id === "string" && typeof chunk.model === "string") {
                if (identity && (chunk.id !== identity.id || chunk.model !== identity.model))
                  throw fail();
                identity = { id: chunk.id, model: chunk.model };
              }
            }
          }
          if (new TextEncoder().encode(pending).length > 1024 * 1024) throw fail();
        }
        controller.enqueue(value);
      } catch {
        if (closed) return;
        closed = true;
        cleanup();
        await cancelReader().catch(() => {});
        controller.error(fail());
      }
    },
    async cancel(reason) {
      closed = true;
      cleanup();
      await cancelReader(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
