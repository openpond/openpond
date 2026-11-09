import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

/** Retry only the read-only release transfer. A checksum mismatch is terminal
 * and no unverified bytes reach the installer. */
export async function downloadVerifiedActionlintArchive(url: string, expectedSha256: string, dependencies: {
  fetch?: typeof fetch;
  pause?: (milliseconds: number) => Promise<unknown>;
} = {}): Promise<Buffer> {
  const request = dependencies.fetch ?? fetch, pause = dependencies.pause ?? setTimeout;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await pause(1000 * 2 ** (attempt - 1));
    let response: Response | undefined;
    try { response = await request(url, { signal: AbortSignal.timeout(20_000) }); }
    catch (cause) { lastError = cause; }
    if (!response) continue;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`failed to download ${url}: HTTP ${response.status}`);
      if (![408, 429].includes(response.status) && response.status < 500) throw lastError;
      continue;
    }
    let archive: Buffer;
    try { archive = Buffer.from(await response.arrayBuffer()); }
    catch (cause) { lastError = cause; continue; }
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== expectedSha256)
      throw new Error(`checksum mismatch for ${url}: expected ${expectedSha256}, received ${actual}`);
    return archive;
  }
  throw new Error(`Unable to download the pinned actionlint release after four attempts.`, { cause: lastError });
}
