import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { CONNECTED_EVIDENCE_LIMITS } from "../connected-evidence/contracts.js";

/** Streaming inventory may prove an irrelevant source without retaining it.
 * It never truncates a selected conversation into an admissible snapshot. */
export async function inspectCodexWindow(input: {
  path: string;
  sessionId: string;
  since: string | null;
  until: string;
  check(): Promise<void>;
}): Promise<{ sha256: string } | null> {
  const handle = await open(input.path, "r");
  try {
    const initial = await handle.stat();
    // This is an inventory I/O bound, independent of the smaller upload bound.
    if (!initial.isFile() || initial.size > 512 * 1024 * 1024) return null;
    const digest = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const from = input.since === null ? -Infinity : Date.parse(input.since);
    const to = Date.parse(input.until);
    let metadata = false, records = 0, bytes = 0;
    let pending: Buffer[] = [], pendingBytes = 0;
    const inspect = (line: Buffer): boolean => {
      if (++records > 1_000_000 || line.byteLength > CONNECTED_EVIDENCE_LIMITS.lineBytes) return false;
      let text: string;
      try { text = decoder.decode(line); } catch { return false; }
      if (!text.trim()) return true;
      let row: unknown;
      try { row = JSON.parse(text); } catch { return false; }
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const value = row as Record<string, unknown>;
      const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
        ? value.payload as Record<string, unknown> : {};
      if (value.type === "session_meta") {
        if (metadata || payload.id !== input.sessionId) return false;
        metadata = true;
      }
      // The Codex normalizer maps other native records to unknown events;
      // they cannot create request boundaries. Missing metadata is still refused.
      const request = value.type === "response_item" && payload.type === "message" && payload.role === "user"
        || value.type === "event_msg" && payload.type === "user_message";
      if (request) {
        const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
        if (!Number.isFinite(timestamp) || timestamp >= from && timestamp < to) return false;
      }
      return true;
    };
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      await input.check();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > 512 * 1024 * 1024) return null;
      digest.update(buffer);
      let start = 0, end: number;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        const part = buffer.subarray(start, end);
        if (pendingBytes + part.byteLength > CONNECTED_EVIDENCE_LIMITS.lineBytes) return null;
        const line = pending.length ? Buffer.concat([...pending, part], pendingBytes + part.byteLength) : part;
        if (!inspect(line)) return null;
        pending = []; pendingBytes = 0;
        start = end + 1;
      }
      const tail = buffer.subarray(start);
      if (tail.byteLength) { pending.push(tail); pendingBytes += tail.byteLength; }
      if (pendingBytes > CONNECTED_EVIDENCE_LIMITS.lineBytes) return null;
    }
    if (pendingBytes && !inspect(Buffer.concat(pending, pendingBytes))) return null;
    const final = await handle.stat();
    if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size
      || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs || bytes !== final.size)
      throw new Error("Native source changed during window inventory.");
    return metadata ? { sha256: digest.digest("hex") } : null;
  } finally { await handle.close(); }
}
