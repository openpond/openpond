const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Bounds real streaming responses, including custom fetch adapters that do not honor abort themselves. */
export async function fetchConnectedJson(fetcher: typeof fetch, url: string, init: RequestInit, error: (status: number, code: string, message: string) => Error) {
  const controller = new AbortController(), external = init.signal;
  const forward = () => controller.abort(external?.reason);
  if (external?.aborted) forward(); else external?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Connected evidence request timed out.")), 60_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortReader = () => { if (reader) void reader.cancel(controller.signal.reason).catch(() => undefined); };
  controller.signal.addEventListener("abort", abortReader, { once: true });
  const abortPromise = new Promise<never>((_, reject) => {
    const abort = () => reject(controller.signal.reason ?? new DOMException("Request aborted", "AbortError"));
    if (controller.signal.aborted) abort(); else controller.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const pendingResponse = fetcher(url, { ...init, signal: controller.signal }).then(response => {
      if (controller.signal.aborted) { void response.body?.cancel(controller.signal.reason).catch(() => undefined); throw controller.signal.reason; }
      return response;
    });
    const response = await Promise.race([pendingResponse, abortPromise]);
    const declared = response.headers.get("content-length");
    reader = response.body?.getReader();
    if (controller.signal.aborted) { await reader?.cancel(controller.signal.reason); throw controller.signal.reason; }
    if (declared && Number(declared) > MAX_RESPONSE_BYTES) { await reader?.cancel(); throw error(502, "connected_response_too_large", "Connected evidence response exceeds 8 MiB."); }
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw error(502, "connected_response_too_large", "Connected evidence response exceeds 8 MiB."); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw error(502, "connected_response_invalid", "Connected evidence response is not valid JSON."); }
    return { response, value };
  } finally { clearTimeout(timer); external?.removeEventListener("abort", forward); controller.signal.removeEventListener("abort", abortReader); reader?.releaseLock(); }
}
