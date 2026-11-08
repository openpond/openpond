import { ProductModelError } from "./product-models.js";

/** Bound the optional provider's otherwise unbounded parser and require the
 * personalized gateway's terminal marker before treating EOF as completion. */
export function boundProductModelResponse(response: Response): Response {
  if (!response.body) return response;
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
      response.headers.get("x-openpond-request-id") ??
        response.headers.get("x-request-id") ??
        undefined,
    );
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (streaming && !terminal) throw fail();
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
        await reader.cancel().catch(() => {});
        controller.error(fail());
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
