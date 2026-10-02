import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { NATIVE_READ_LIMIT, type NativeSource } from "./contracts.js";

/** Read the native cold-storage envelope without restoring or modifying its database. */
export function readOpenClawColdArchive(
  database: DatabaseSync,
  source: NativeSource,
  sessionId: string,
) {
  const metadata = database
    .prepare(
      "SELECT generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,storage,length(archive_blob) AS blob_bytes FROM session_transcript_cold_archives WHERE session_id=?",
    )
    .get(sessionId);
  if (!metadata) return null;
  if (
    Number(metadata.archive_bytes) > NATIVE_READ_LIMIT ||
    Number(metadata.raw_bytes) > NATIVE_READ_LIMIT ||
    Number(metadata.event_count) > 100000
  )
    throw new Error("OpenClaw cold archive exceeds the retained size limit.");
  let bytes: Uint8Array;
  if (metadata.storage === "sqlite") {
    if (Number(metadata.blob_bytes) !== Number(metadata.archive_bytes))
      throw new Error("OpenClaw cold archive size differs from its receipt.");
    const row = database
      .prepare(
        "SELECT archive_blob FROM session_transcript_cold_archives WHERE session_id=?",
      )
      .get(sessionId)!;
    if (!(row.archive_blob instanceof Uint8Array))
      throw new Error("OpenClaw cold archive is unavailable.");
    bytes = row.archive_blob;
  } else if (metadata.storage === "file") {
    const name = String(metadata.archive_name);
    if (!/^[a-f0-9]{64}\.jsonl\.zst$/.test(name))
      throw new Error("Invalid OpenClaw cold archive name.");
    const storeDirectory = dirname(source.root);
    const artifactDirectory =
      basename(storeDirectory) === "agent"
        ? join(dirname(storeDirectory), "sessions")
        : storeDirectory;
    const allowed = realpathSync(artifactDirectory);
    const path = realpathSync(join(artifactDirectory, "cold", name));
    const within = relative(allowed, path);
    if (
      within === ".." ||
      within.startsWith(`..${sep}`) ||
      within.startsWith(sep)
    )
      throw new Error(
        "OpenClaw cold archive leaves the selected agent directory.",
      );
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== Number(metadata.archive_bytes))
      throw new Error("OpenClaw cold archive size differs from its receipt.");
    bytes = readFileSync(path);
  } else throw new Error("Unsupported OpenClaw cold archive storage.");
  if (
    bytes.length !== Number(metadata.archive_bytes) ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.archive_sha256
  )
    throw new Error("OpenClaw cold archive checksum differs from its receipt.");
  const decoded = zstdDecompressSync(bytes, {
    maxOutputLength: NATIVE_READ_LIMIT,
  });
  const lines = new TextDecoder("utf8", { fatal: true })
    .decode(decoded)
    .trimEnd()
    .split("\n");
  const header = JSON.parse(lines.shift() ?? "null");
  if (
    header?.kind !== "header" ||
    header.version !== 1 ||
    header.sessionId !== sessionId ||
    header.generation !== metadata.generation
  )
    throw new Error("OpenClaw cold archive identity differs from its receipt.");
  const events: string[] = [];
  let lastSequence = -1;
  let rawBytes = 0;
  for (const line of lines) {
    const record = JSON.parse(line);
    if (!["event", "identity", "active", "index", "fts"].includes(record?.kind))
      throw new Error("Unsupported OpenClaw cold archive record.");
    if (record.kind !== "event") continue;
    if (
      !Number.isSafeInteger(record.row?.seq) ||
      record.row.seq <= lastSequence ||
      typeof record.row.event_json !== "string"
    )
      throw new Error("Invalid OpenClaw cold archive event sequence.");
    lastSequence = record.row.seq;
    rawBytes += Buffer.byteLength(record.row.event_json);
    events.push(record.row.event_json);
  }
  if (
    events.length !== Number(metadata.event_count) ||
    lastSequence !== Number(metadata.last_seq) ||
    rawBytes + events.length - 1 !== Number(metadata.raw_bytes)
  )
    throw new Error("OpenClaw cold archive contents differ from its receipt.");
  const nativeHeader = JSON.parse(events[0] ?? "null");
  if (nativeHeader?.type !== "session" || nativeHeader.id !== sessionId)
    throw new Error(
      "OpenClaw transcript identity differs from selected session.",
    );
  return { path: `${sessionId}.jsonl`, text: events.join("\n") + "\n" };
}
