import { ExampleError } from "./config.js";

/** Bound bodies before parsing; never surface remote bodies (which may contain credentials). */
export async function readResponseJson(response: Response, maxBytes = 512 * 1024): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ExampleError(`upstream_http_${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ExampleError("upstream_body_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new ExampleError("upstream_body_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
