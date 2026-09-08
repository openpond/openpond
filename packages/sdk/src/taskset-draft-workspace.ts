import { z } from "zod";
import { contentHash, sha256 } from "@openpond/harness";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { TasksetDraftSchema } from "./taskset-draft-document.js";
import { TasksetDraftFileMutationSchema, TasksetDraftFilePathSchema, type TasksetDraftFileMutation } from "./model-taskset-authoring-contracts.js";
import { createTasksetDraftFile, decodeTasksetDraftFileContent, isManagedTasksetDraftFilePath, isWritableTasksetDraftFilePath } from "./taskset-draft-files.js";
import { configuredTasksetDraftFiles, renderTasksetDraftManifests } from "./taskset-draft-manifests.js";

export const MAX_TASKSET_DRAFT_WORKSPACE_BYTES = 64 * 1024 * 1024;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TasksetDraftWorkspaceFileSchema = z.object({
  path: TasksetDraftFilePathSchema,
  contentHash: HashSchema,
  sizeBytes: z.number().int().nonnegative().max(MAX_TASKSET_DRAFT_WORKSPACE_BYTES),
  base64: z.string().max(MAX_TASKSET_DRAFT_WORKSPACE_BYTES),
}).strict();
const WorkspaceContentSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftWorkspace.v1"),
  draft: TasksetDraftSchema,
  files: z.array(TasksetDraftWorkspaceFileSchema).max(10_000),
}).strict();
export const TasksetDraftWorkspaceSchema = WorkspaceContentSchema.extend({ contentHash: HashSchema }).strict();
export type TasksetDraftWorkspace = z.infer<typeof TasksetDraftWorkspaceSchema>;
export type TasksetDraftWorkspaceFile = z.infer<typeof TasksetDraftWorkspaceFileSchema>;

/** Files are retained separately from the structured document, including bytes
 * too large for the code editor. Publication remains a separate validation step. */
export function createTasksetDraftWorkspace(input: z.input<typeof WorkspaceContentSchema>): TasksetDraftWorkspace {
  assertBoundedTaskJson(input, MAX_TASKSET_DRAFT_WORKSPACE_BYTES);
  const content = WorkspaceContentSchema.parse(input);
  content.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return validateTasksetDraftWorkspace({ ...content, contentHash: contentHash(content) });
}

export function validateTasksetDraftWorkspace(input: unknown): TasksetDraftWorkspace {
  assertBoundedTaskJson(input, MAX_TASKSET_DRAFT_WORKSPACE_BYTES);
  const workspace = TasksetDraftWorkspaceSchema.parse(input);
  const { contentHash: expectedHash, ...content } = workspace;
  if (contentHash(content) !== expectedHash) throw new Error("Taskset draft workspace differs from its retained bytes.");
  let previousPath: string | null = null;
  const paths = new Set<string>();
  for (const file of workspace.files) {
    if (isManagedTasksetDraftFilePath(file.path)) throw new Error("Managed Taskset files are represented by the draft document.");
    if (previousPath !== null && previousPath >= file.path) throw new Error("Taskset draft file paths must be unique and sorted.");
    const segments = file.path.split("/");
    for (let end = 1; end < segments.length; end++) if (paths.has(segments.slice(0, end).join("/"))) throw new Error("A Taskset draft file occupies another file's directory.");
    decodeTasksetDraftWorkspaceFile(file);
    paths.add(file.path);
    previousPath = file.path;
  }
  return workspace;
}

export function readTasksetDraftWorkspaceFile(input: TasksetDraftWorkspace, path: string) {
  const workspace = validateTasksetDraftWorkspace(input);
  TasksetDraftFilePathSchema.parse(path);
  const file = workspace.files.find(candidate => candidate.path === path);
  const manifest = isManagedTasksetDraftFilePath(path) ? renderTasksetDraftManifests(workspace.draft).get(path) : undefined;
  if (!file && manifest === undefined) throw new Error("Taskset draft file does not exist.");
  const result = createTasksetDraftFile(path, file ? decodeTasksetDraftWorkspaceFile(file) : new TextEncoder().encode(manifest!));
  return { draftRevision: workspace.draft.revision, file: { ...result, writable: result.writable && workspace.draft.status !== "published" } };
}

export function listTasksetDraftWorkspaceFiles(input: TasksetDraftWorkspace) {
  const workspace = validateTasksetDraftWorkspace(input);
  const files = workspace.files.map(file => ({ path: file.path, sizeBytes: file.sizeBytes,
    writable: workspace.draft.status !== "published" && isWritableTasksetDraftFilePath(file.path) }));
  for (const [path, content] of renderTasksetDraftManifests(workspace.draft)) files.push({ path, sizeBytes: new TextEncoder().encode(content).byteLength, writable: false });
  return { draftRevision: workspace.draft.revision, files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
}

export function saveTasksetDraftWorkspaceDocument(input: { workspace: TasksetDraftWorkspace; expectedDraftRevision: number; draft: unknown; now: string }): TasksetDraftWorkspace {
  const workspace = editableWorkspace(input.workspace, input.expectedDraftRevision);
  const draft = TasksetDraftSchema.parse(input.draft);
  const current = workspace.draft;
  if (draft.id !== current.id || draft.profileId !== current.profileId || contentHash(draft.modelScope) !== contentHash(current.modelScope)) throw new Error("Taskset draft Model ownership cannot change.");
  if (draft.revision !== current.revision || draft.status !== current.status || draft.createdAt !== current.createdAt || contentHash(draft.publishedTasksetRef) !== contentHash(current.publishedTasksetRef)) throw new Error("Taskset draft lifecycle fields cannot change through form edits.");
  const files = [...workspace.files];
  for (const configured of configuredTasksetDraftFiles(draft)) if (!files.some(file => file.path === configured.relativePath)) {
    const bytes = new TextEncoder().encode(configured.source);
    files.push({ path: configured.relativePath, contentHash: sha256(bytes), sizeBytes: bytes.byteLength, base64: base64(bytes) });
  }
  const aggregator = draft.metrics.customAggregator;
  const module = aggregator ? files.find(file => file.path === aggregator.module) : undefined;
  return createTasksetDraftWorkspace({ schemaVersion: workspace.schemaVersion, files,
    draft: { ...draft, revision: current.revision + 1, status: "draft", updatedAt: input.now,
      ...(aggregator && module ? { metrics: { ...draft.metrics, customAggregator: { ...aggregator, contentHash: module.contentHash } } } : {}) } });
}

export function saveTasksetDraftWorkspaceFile(input: { workspace: TasksetDraftWorkspace; mutation: TasksetDraftFileMutation; now: string }): TasksetDraftWorkspace {
  const mutation = TasksetDraftFileMutationSchema.parse(input.mutation);
  const workspace = editableWorkspace(input.workspace, mutation.expectedDraftRevision);
  if (workspace.draft.id !== mutation.draftId) throw new Error("Taskset draft file belongs to another draft.");
  if (!isWritableTasksetDraftFilePath(mutation.path)) throw new Error("This file is managed by the Taskset forms or retained source history.");
  const previous = workspace.files.find(file => file.path === mutation.path);
  if ((previous?.contentHash ?? null) !== mutation.expectedFileHash) throw new Error("Taskset draft file changed. Reload it before saving.");
  if (!previous && mutation.content === null) throw new Error("Taskset draft file does not exist.");
  const files = workspace.files.filter(file => file.path !== mutation.path);
  if (mutation.content !== null) {
    const bytes = decodeTasksetDraftFileContent(mutation.content);
    files.push({ path: mutation.path, contentHash: sha256(bytes), sizeBytes: bytes.byteLength, base64: base64(bytes) });
  }
  return createTasksetDraftWorkspace({ schemaVersion: workspace.schemaVersion, files,
    draft: { ...workspace.draft, revision: workspace.draft.revision + 1, status: "draft", updatedAt: input.now } });
}

function editableWorkspace(input: unknown, expectedRevision: number): TasksetDraftWorkspace {
  const workspace = validateTasksetDraftWorkspace(input);
  if (workspace.draft.status === "published") throw new Error("Published Taskset drafts are immutable.");
  if (workspace.draft.revision !== expectedRevision) throw new Error("Taskset draft changed. Reload before saving.");
  return workspace;
}

export function decodeTasksetDraftWorkspaceFile(input: TasksetDraftWorkspaceFile): Uint8Array {
  const file = TasksetDraftWorkspaceFileSchema.parse(input);
  let raw: string;
  try { raw = atob(file.base64); }
  catch { throw new Error("Taskset draft file contains invalid base64."); }
  if (btoa(raw) !== file.base64) throw new Error("Taskset draft file contains noncanonical base64.");
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== file.contentHash) throw new Error("Taskset draft file differs from its retained bytes.");
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let raw = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(raw);
}
