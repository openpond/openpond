import { sha256 } from "@openpond/harness";
import { TasksetDraftFileContentSchema, TasksetDraftFilePathSchema, type TasksetDraftFile } from "./model-taskset-authoring-contracts.js";

export const MAX_TASKSET_DRAFT_EDIT_FILE_BYTES = 6_000_000;
const MANAGED_FILES = new Set(["taskset.json", "capabilities.json", "data/tasks.jsonl", "tasks/tasks.jsonl", "graders/graders.json", "fixtures/grader-fixtures.json", "metrics/policy.json", "assets/manifest.json", "environment/contract.json", "environment/taskset.ts", "rubrics/preference-review.md", "comparisons/policy.json"]);

export function isWritableTasksetDraftFilePath(value: string): boolean {
  const path = TasksetDraftFilePathSchema.parse(value);
  return !MANAGED_FILES.has(path) && !path.startsWith("source-artifacts/");
}

export function isManagedTasksetDraftFilePath(value: string): boolean {
  return MANAGED_FILES.has(TasksetDraftFilePathSchema.parse(value));
}

/** Editor transport retains exact bytes, including a UTF-8 byte-order mark. */
export function createTasksetDraftFile(path: string, bytes: Uint8Array): TasksetDraftFile {
  const writable = isWritableTasksetDraftFilePath(path);
  if (bytes.byteLength > MAX_TASKSET_DRAFT_EDIT_FILE_BYTES) throw new Error("Taskset draft file content is invalid or exceeds 6 MB.");
  let content: TasksetDraftFile["content"];
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    content = /[\u0000-\u0008\u000e-\u001f]/.test(text) ? base64Content(bytes) : { encoding: "utf8", data: text };
  } catch { content = base64Content(bytes); }
  return { path, writable, content, sizeBytes: bytes.byteLength, contentHash: sha256(bytes) };
}

export function decodeTasksetDraftFileContent(input: unknown): Uint8Array {
  const content = TasksetDraftFileContentSchema.parse(input);
  let bytes: Uint8Array;
  try {
    if (content.encoding === "utf8") bytes = new TextEncoder().encode(content.data);
    else {
      const raw = atob(content.data);
      if (btoa(raw) !== content.data) throw new Error("Noncanonical base64");
      bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    }
  } catch { throw new Error("Taskset draft file content is invalid or exceeds 6 MB."); }
  if (bytes.byteLength > MAX_TASKSET_DRAFT_EDIT_FILE_BYTES) throw new Error("Taskset draft file content is invalid or exceeds 6 MB.");
  return bytes;
}

function base64Content(bytes: Uint8Array): TasksetDraftFile["content"] {
  // Avoid spreading a multi-megabyte file onto the JavaScript call stack.
  let raw = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { encoding: "base64", data: btoa(raw) };
}
