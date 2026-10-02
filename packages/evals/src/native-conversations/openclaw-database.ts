import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readOpenClawColdArchive } from "./openclaw-cold-archive.js";
import {
  NATIVE_READ_LIMIT,
  type NativeSession,
  type NativeSource,
} from "./contracts.js";

function open(source: NativeSource) {
  const database = new DatabaseSync(source.root, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
  return database;
}
function has(database: DatabaseSync, table: string) {
  return !!database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
}
export function listOpenClawSessions(
  source: NativeSource,
  input: { since?: string; cursor?: string; limit: number },
) {
  const database = open(source);
  try {
    // Every hot transcript retains a native session header, including prior reset windows.
    const archiveUnion = has(database, "session_transcript_archives")
      ? "UNION ALL SELECT session_id AS id,created_at AS updated,archive_sha256 AS revision FROM session_transcript_archives"
      : "";
    const coldUnion = has(database, "session_transcript_cold_archives")
      ? "UNION ALL SELECT session_id AS id,archived_at AS updated,archive_sha256 AS revision FROM session_transcript_cold_archives"
      : "";
    const rows = database
      .prepare(
        `SELECT id,MAX(updated) AS updated,MAX(revision) AS revision FROM (
      SELECT session_id AS id,MAX(created_at) AS updated,CAST(MAX(seq) AS TEXT) AS revision FROM transcript_events GROUP BY session_id
      ${archiveUnion} ${coldUnion}) WHERE id > ? GROUP BY id ORDER BY id LIMIT ?`,
      )
      .all(input.cursor ?? "", input.limit + 1);
    const items: NativeSession[] = rows.slice(0, input.limit).map((row) => ({
      nativeSessionId: String(row.id),
      sourceInstanceId: source.instanceId,
      path: String(row.id),
      title: String(row.id),
      cwd: null,
      updatedAt: new Date(Number(row.updated) || 0).toISOString(),
    }));
    return {
      items,
      nextCursor:
        rows.length > input.limit ? items.at(-1)!.nativeSessionId : null,
    };
  } finally {
    database.close();
  }
}
export function readOpenClawSession(source: NativeSource, sessionId: string) {
  const database = open(source);
  try {
    if (has(database, "session_transcript_cold_archives")) {
      const cold = readOpenClawColdArchive(database, source, sessionId);
      if (cold) return cold;
    }
    const hasHot = database
      .prepare("SELECT 1 FROM transcript_events WHERE session_id=? LIMIT 1")
      .get(sessionId);
    if (!hasHot) {
      if (!has(database, "session_transcript_archives"))
        throw new Error("OpenClaw archive is unavailable.");
      const metadata = database
        .prepare(
          "SELECT archive_name,length(archive_blob) AS bytes FROM session_transcript_archives WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(sessionId);
      if (!metadata || Number(metadata.bytes) > NATIVE_READ_LIMIT)
        throw new Error(
          "OpenClaw archive is missing or exceeds the retained byte limit.",
        );
      const archive = database
        .prepare(
          "SELECT archive_blob,archive_sha256,encoding FROM session_transcript_archives WHERE archive_name=? AND session_id=?",
        )
        .get(String(metadata.archive_name), sessionId)!;
      if (
        !(archive.archive_blob instanceof Uint8Array) ||
        createHash("sha256").update(archive.archive_blob).digest("hex") !==
          archive.archive_sha256
      )
        throw new Error(
          "OpenClaw archive checksum differs from its retained receipt.",
        );
      if (archive.encoding !== "zstd" && archive.encoding !== "identity")
        throw new Error("Unsupported OpenClaw archive encoding.");
      const bytes =
        archive.encoding === "zstd"
          ? zstdDecompressSync(archive.archive_blob, {
              maxOutputLength: NATIVE_READ_LIMIT,
            })
          : archive.archive_blob;
      const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      const header = JSON.parse(text.split("\n", 1)[0]!);
      if (header.type !== "session" || header.id !== sessionId)
        throw new Error(
          "OpenClaw archive identity differs from selected session.",
        );
      return { path: `${sessionId}.jsonl`, text };
    }
    const total = database
      .prepare(
        "SELECT COUNT(*) AS n,SUM(COALESCE(event_utf8_bytes,length(CAST(event_json AS BLOB)),0)) AS bytes FROM transcript_events WHERE session_id=?",
      )
      .get(sessionId)!;
    if (Number(total.n) > 100000 || Number(total.bytes) > NATIVE_READ_LIMIT)
      throw new Error("OpenClaw transcript exceeds the retained size limit.");
    const rows = database
      .prepare(
        "SELECT seq,event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq LIMIT 100001",
      )
      .all(sessionId);
    let bytes = 0;
    const lines = rows.map((row) => {
      let text: string;
      if (typeof row.event_json === "string") text = row.event_json;
      else {
        if (
          !(row.event_zstd instanceof Uint8Array) ||
          Number(row.event_utf8_bytes) > NATIVE_READ_LIMIT
        )
          throw new Error("Unsupported OpenClaw compressed transcript record.");
        const decoded = zstdDecompressSync(row.event_zstd, {
          maxOutputLength: NATIVE_READ_LIMIT,
        });
        if (decoded.length !== Number(row.event_utf8_bytes))
          throw new Error(
            "OpenClaw compressed transcript size differs from its receipt.",
          );
        text = new TextDecoder("utf8", { fatal: true }).decode(decoded);
      }
      bytes += Buffer.byteLength(text);
      if (bytes > NATIVE_READ_LIMIT)
        throw new Error("OpenClaw transcript exceeds retained size limit.");
      return text;
    });
    if (!lines.length) throw new Error("OpenClaw transcript is unavailable.");
    const header = JSON.parse(lines[0]!);
    if (header.type !== "session" || header.id !== sessionId)
      throw new Error(
        "OpenClaw transcript identity differs from selected session.",
      );
    return { path: `${sessionId}.jsonl`, text: lines.join("\n") + "\n" };
  } finally {
    database.close();
  }
}
