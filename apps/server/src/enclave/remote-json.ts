export class EnclaveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function normalizeModelEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new EnclaveError(400, "Enter a valid model endpoint URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new EnclaveError(400, "Use HTTPS, or HTTP for a local model, without credentials, a query, or fragment in the URL.");
  }
  return url.toString().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/** Bound bodies and deadlines; never follow a redirect carrying a caller key. */
export async function remoteJson(input: {
  endpoint: string; path: string; token: string; body?: unknown; signal?: AbortSignal;
  timeoutMs?: number; fetch?: typeof fetch; expectedStatus?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, input.timeoutMs ?? 15_000);
  try {
    const response = await (input.fetch ?? fetch)(`${normalizeModelEndpoint(input.endpoint)}/${input.path}`, {
      method: input.body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
      headers: { ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}), "Content-Type": "application/json", "User-Agent": "OpenPond-Model-Connection/1.0" },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    if (input.expectedStatus && response.status === input.expectedStatus) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EnclaveError(response.status === 401 || response.status === 403 ? 401 : response.status === 503 ? 503 : 502,
        response.status === 401 || response.status === 403 ? "The endpoint rejected the API key. Check its credentials." :
        response.status === 503 ? "The endpoint is starting or busy. Try again shortly." : "The endpoint did not return a compatible response.");
    }
    if (!response.body) throw new EnclaveError(502, "The endpoint returned an empty response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) throw new EnclaveError(502, "The endpoint response exceeded its size limit.");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof EnclaveError) throw error;
    if (controller.signal.aborted) throw new EnclaveError(408, input.signal?.aborted ? "Request cancelled." : "The endpoint request timed out.");
    throw new EnclaveError(502, "Could not reach a compatible model endpoint. Check the URL and service health.");
  } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
}
