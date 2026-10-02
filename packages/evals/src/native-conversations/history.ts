import {
  open,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { previewAgentImport } from "../connected-evidence/imports.js";
import { object } from "../connected-evidence/normalize.js";
import { listDatabaseSessions, readDatabaseSession } from "./database.js";
import {
  NATIVE_READ_LIMIT,
  type NativeSession,
  type NativeSource,
} from "./contracts.js";

async function selectedPath(
  source: NativeSource,
  path: string,
  boundSize = true,
) {
  const root = await realpath(source.root),
    target = await realpath(resolve(root, path));
  const child = relative(root, target);
  if (child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child))
    throw new Error("History path is outside the selected source.");
  if (boundSize && (await stat(target)).size > NATIVE_READ_LIMIT)
    throw new Error("Source file exceeds 32 MiB.");
  return target;
}
async function readSelectedFile(source: NativeSource, path: string) {
  const target = await selectedPath(source, path),
    bytes = await readFile(target);
  if (bytes.byteLength > NATIVE_READ_LIMIT)
    throw new Error("Source changed beyond the retained limit.");
  const decoded = target.endsWith(".zst")
    ? zstdDecompressSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
    : bytes;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  // A writer may be appending its last line. Only complete JSONL records enter snapshots.
  if (target.endsWith(".jsonl") && text && !text.endsWith("\n")) {
    const last = text.lastIndexOf("\n");
    try {
      JSON.parse(text.slice(last + 1));
    } catch {
      return text.slice(0, last + 1);
    }
  }
  return text;
}
async function pathsBelow(source: NativeSource) {
  if ((await lstat(source.root)).isFile()) return [""];
  const roots =
    source.source === "codex"
      ? ["sessions", "archived_sessions"]
      : source.source === "grok_build"
        ? ["sessions"]
        : source.source === "claude_code"
          ? ["projects"]
          : source.source === "pi" || source.source === "oh_my_pi"
            ? ["sessions"]
            : [""];
  const paths: string[] = [];
  async function walk(directory: string, depth: number) {
    if (depth > 12)
      throw new Error("Selected history exceeds directory depth limit.");
    let entries;
    try {
      entries = await readdir(join(source.root, directory), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (
        entry.isFile() &&
        (source.source === "openclaw"
          ? entry.name === "manifest.json"
          : source.source === "grok_build"
            ? entry.name === "updates.jsonl"
            : /\.jsonl(?:\.zst)?$/u.test(entry.name))
      )
        paths.push(path);
      if (paths.length > 10000)
        throw new Error(
          "Select a narrower source directory (more than 10,000 history files).",
        );
    }
  }
  for (const root of roots) await walk(root, 0);
  // Explicit export directories need not mimic the application's home layout.
  if (!paths.length && roots[0] !== "") await walk("", 0);
  return paths.sort();
}
function sessionFileJson(source: NativeSource, path: string) {
  return (path || source.root).endsWith(".json");
}
export async function listSessions(
  source: NativeSource,
  input: { since?: string; cursor?: string; limit?: number } = {},
) {
  if (!source.available || !source.capabilities.history)
    throw new Error(source.reason ?? "Native history is unavailable.");
  const limit = input.limit ?? 50;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.since && !Number.isFinite(Date.parse(input.since)))
  )
    throw new Error("Invalid history page or date range.");
  if (source.acquisition === "sqlite")
    return listDatabaseSessions(source, { ...input, limit });
  const paths = await pathsBelow(source),
    candidates: NativeSession[] = [];
  for (const path of paths) {
    if (input.cursor && path <= input.cursor) continue;
    try {
      const modified = await stat(join(source.root, path));
      if (input.since && modified.mtimeMs < Date.parse(input.since)) continue;
      let text: string;
      if (
        source.acquisition !== "bundle" &&
        !sessionFileJson(source, path) &&
        source.source !== "hermes" &&
        !(path || source.root).endsWith(".zst")
      ) {
        const handle = await open(await selectedPath(source, path, false), "r");
        try {
          const buffer = Buffer.alloc(256 * 1024),
            read = await handle.read(buffer, 0, buffer.length, 0);
          const prefix = buffer.subarray(0, read.bytesRead).toString("utf8"),
            end = prefix.lastIndexOf("\n");
          text = prefix;
          if (!prefix.endsWith("\n")) {
            try {
              JSON.parse(prefix.slice(end + 1));
            } catch {
              text = prefix.slice(0, end + 1);
            }
          }
        } finally {
          await handle.close();
        }
      } else text = await readSelectedFile(source, path);
      const rows =
        source.acquisition === "bundle" || sessionFileJson(source, path)
          ? [object(JSON.parse(text))]
          : text
              .split(/\r?\n/u)
              .filter(Boolean)
              .slice(0, 12)
              .map((line) => object(JSON.parse(line)));
      const header =
        rows.find(
          (row) => row.type === "session" || row.type === "session_meta",
        ) ??
        rows[0] ??
        {};
      const payload =
        header.type === "session_meta"
          ? object(header.payload)
          : source.source === "grok_build"
            ? object(header.params)
            : source.source === "opencode"
              ? object(header.info)
              : header;
      const id =
        typeof payload.id === "string"
          ? payload.id
          : typeof payload.sessionId === "string"
            ? payload.sessionId
            : basename(path).replace(/\.jsonl(?:\.zst)?$/u, "");
      candidates.push({
        nativeSessionId: id,
        sourceInstanceId: source.instanceId,
        path,
        title: id,
        cwd: typeof payload.cwd === "string" ? payload.cwd : null,
        updatedAt: modified.mtime.toISOString(),
        storageRevision: [
          modified.dev,
          modified.ino,
          modified.size,
          modified.mtimeMs,
          modified.ctimeMs,
        ].join(":"),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      candidates.push({
        nativeSessionId: basename(path || source.root),
        sourceInstanceId: source.instanceId,
        path,
        title: basename(path || source.root),
        cwd: null,
        updatedAt: new Date(0).toISOString(),
        issue:
          error instanceof Error
            ? error.message
            : "Unable to inspect native session",
      });
    }
    if (candidates.length > limit) break;
  }
  return {
    items: candidates.slice(0, limit),
    nextCursor: candidates.length > limit ? candidates[limit - 1]!.path : null,
  };
}
export async function readSession(
  source: NativeSource,
  session: NativeSession,
  input: { branchLeafId?: string } = {},
) {
  if (session.issue) throw new Error(session.issue);
  if (session.sourceInstanceId !== source.instanceId)
    throw new Error("Native session belongs to another selected source.");
  let files;
  if (source.acquisition === "sqlite")
    files = [readDatabaseSession(source, session.nativeSessionId)];
  else if (source.acquisition === "bundle") {
    const directory = session.path.slice(0, -"manifest.json".length);
    files = await Promise.all(
      ["manifest.json", "events.jsonl", "session-branch.json"].map(
        async (path) => ({
          path,
          text: await readSelectedFile(source, `${directory}${path}`),
        }),
      ),
    );
  } else
    files = [
      {
        path: basename(session.path || source.root).replace(/\.zst$/u, ""),
        text: await readSelectedFile(source, session.path),
      },
    ];
  const preview = previewAgentImport({
    source: source.source,
    files,
    acquisition: {
      machineId: source.machineId,
      sourceInstanceId: source.instanceId,
    },
    ...input,
  });
  if (preview.issues.length)
    throw new Error(preview.issues.map((issue) => issue.message).join("; "));
  if (
    source.acquisition === "sqlite" &&
    preview.sessions.some((item) => item.sessionId !== session.nativeSessionId)
  )
    throw new Error("Native session changed identity.");
  return { files, preview };
}
