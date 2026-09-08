import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, withFileLock } from "@openpond/persistence";
import { TasksetDraftFilePathSchema, type TasksetDraftFile, type TasksetDraftFileInfo, type TasksetDraftFileMutation } from "openpond-sdk/model-taskset-authoring";

const MAX_FILE_BYTES = 6_000_000;
const MANAGED_FILES = new Set(["taskset.json", "capabilities.json", "data/tasks.jsonl", "tasks/tasks.jsonl", "graders/graders.json", "fixtures/grader-fixtures.json", "metrics/policy.json", "assets/manifest.json", "environment/contract.json", "environment/taskset.ts", "rubrics/preference-review.md", "comparisons/policy.json"]);
export const withTasksetDraftLock = <T>(home: string, action: () => Promise<T>) => withFileLock(path.join(home, "state", "taskset-draft-writes"), action);
const writable = (relative: string) => !MANAGED_FILES.has(relative) && !relative.startsWith("source-artifacts/");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function regularPath(root: string, relative: string, createParents = false) {
  TasksetDraftFilePathSchema.parse(relative);
  let current = root;
  for (const segment of ["", ...relative.split("/").slice(0, -1)]) {
    if (segment) current = path.join(current, segment);
    if (createParents) await mkdir(current, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Taskset draft paths must use regular directories.");
  }
  return path.join(root, relative);
}

async function readBytes(root: string, relative: string): Promise<Buffer> {
  const target = await regularPath(root, relative);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Taskset draft file must be a regular file within the 6 MB editing limit.");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Taskset draft file changed during reading.");
      offset += read.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error("Taskset draft file changed during reading.");
    return bytes;
  } finally { await file.close(); }
}

export async function readTasksetDraftFile(root: string, relative: string): Promise<TasksetDraftFile> {
  const bytes = await readBytes(root, relative);
  let content: TasksetDraftFile["content"] = { encoding: "base64", data: bytes.toString("base64") };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) content = { encoding: "utf8", data: text };
  } catch { /* Binary files remain exact base64 bytes. */ }
  return { path: relative, contentHash: digest(bytes), sizeBytes: bytes.length, writable: writable(relative), content };
}

export async function listTasksetDraftFiles(root: string): Promise<TasksetDraftFileInfo[]> {
  const files: TasksetDraftFileInfo[] = [];
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      TasksetDraftFilePathSchema.parse(name);
      if (entry.isSymbolicLink()) throw new Error("Taskset draft files cannot contain symbolic links.");
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) throw new Error("Taskset draft files must be regular files.");
      if (files.length >= 10_000) throw new Error("Taskset draft file inventory exceeds its limit.");
      const info = await lstat(await regularPath(root, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Taskset draft files must be regular files.");
      files.push({ path: name, sizeBytes: info.size, writable: writable(name) });
    }
  }
  await regularPath(root, "taskset.json");
  await visit();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The caller holds the draft lock and commits its revision in `commit`.
 * A rejected commit restores the prior bytes; stale file hashes never write. */
export async function mutateTasksetDraftFile<T>(root: string, request: TasksetDraftFileMutation, commit: () => Promise<T>): Promise<T> {
  if (!writable(request.path)) throw new Error("This file is managed by the Taskset forms or retained source history.");
  let previous: Buffer | null = null;
  try { previous = await readBytes(root, request.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if ((previous ? digest(previous) : null) !== request.expectedFileHash) throw new Error("Taskset draft file changed. Reload it before saving.");
  if (!previous && request.content === null) throw new Error("Taskset draft file does not exist.");
  const next = request.content ? Buffer.from(request.content.data, request.content.encoding === "utf8" ? "utf8" : "base64") : null;
  if (next && (next.length > MAX_FILE_BYTES || (request.content?.encoding === "base64" && next.toString("base64") !== request.content.data))) throw new Error("Taskset draft file content is invalid or exceeds 6 MB.");
  const target = await regularPath(root, request.path, true);
  if (next) await atomicWriteFile(target, next);
  else await rm(target);
  try { return await commit(); }
  catch (error) {
    if (previous) await atomicWriteFile(target, previous);
    else await rm(target, { force: true });
    throw error;
  }
}
