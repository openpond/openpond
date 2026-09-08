import { expect, it } from "vitest";
import { sha256 } from "@openpond/harness";
import { createTasksetDraft, TasksetDraftSchema, draftPublishIssues, createTasksetDraftFile, decodeTasksetDraftFileContent, isWritableTasksetDraftFilePath, MAX_TASKSET_DRAFT_EDIT_FILE_BYTES } from "../src/taskset-drafts.js";
import { createTasksetDraftWorkspace, validateTasksetDraftWorkspace, readTasksetDraftWorkspaceFile, saveTasksetDraftWorkspaceDocument, saveTasksetDraftWorkspaceFile } from "../src/taskset-drafts.js";

// An editor must retain incomplete work without treating it as publishable;
// published, benchmark and structured-output documents still require their bindings.
it("retains incomplete editor documents and distinguishes publication requirements", () => {
  const draft = createTasksetDraft({ profileId: "workspace", id: "draft", now: "2026-09-08T12:00:00.000Z" });
  expect(TasksetDraftSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  expect(draftPublishIssues(draft).map(issue => issue.code)).toEqual(["name_missing", "objective_missing", "tasks_missing", "graders_missing", "grader_fixtures_missing"]);
  expect(TasksetDraftSchema.safeParse({ ...draft, status: "published" }).success).toBe(false);
  expect(TasksetDraftSchema.safeParse({ ...draft, purpose: "benchmark" }).success).toBe(false);
  expect(TasksetDraftSchema.safeParse({ ...draft, output: { mode: "structured_json", jsonSchema: null, renderer: null } }).success).toBe(false);
});

// Durable snapshots must reject lost updates and forged ownership while retaining
// all original files; draft editing cannot mutate an earlier stored revision.
it("seals mutable draft snapshots with document and file revision checks", () => {
  const now = "2026-09-08T12:00:00.000Z";
  const draft = createTasksetDraft({ profileId: "workspace", id: "draft", now, modelScope: { modelId: "model", expectedModelRevision: 1 } });
  const original = { path: "private/input.bin", contentHash: sha256(new Uint8Array([0, 255])), sizeBytes: 2, base64: "AP8=" };
  const retained = { ...original, path: "source-artifacts/source.bin" };
  const first = createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft, files: [retained, original] });
  expect(validateTasksetDraftWorkspace(JSON.parse(JSON.stringify(first)))).toEqual(first);
  const mutation = { draftId: draft.id, expectedDraftRevision: 1, path: original.path, expectedFileHash: original.contentHash, content: { encoding: "utf8" as const, data: "changed" } };
  const second = saveTasksetDraftWorkspaceFile({ workspace: first, mutation, now });
  expect(readTasksetDraftWorkspaceFile(second, original.path).file.content.data).toBe("changed");
  expect(readTasksetDraftWorkspaceFile(first, original.path).file.content).toEqual({ encoding: "base64", data: "AP8=" });
  expect(second.files.find(file => file.path === retained.path)).toEqual(retained);
  expect(() => saveTasksetDraftWorkspaceFile({ workspace: second, mutation, now })).toThrow("changed");
  expect(() => saveTasksetDraftWorkspaceFile({ workspace: second, mutation: { ...mutation, expectedDraftRevision: 2 }, now })).toThrow("file changed");
  expect(() => saveTasksetDraftWorkspaceFile({ workspace: first, mutation: { ...mutation, path: retained.path }, now })).toThrow("managed");
  expect(() => saveTasksetDraftWorkspaceDocument({ workspace: second, expectedDraftRevision: 1, draft: second.draft, now })).toThrow("changed");
  expect(() => saveTasksetDraftWorkspaceDocument({ workspace: second, expectedDraftRevision: 2, draft: { ...second.draft, profileId: "foreign" }, now })).toThrow("ownership");
  const third = saveTasksetDraftWorkspaceDocument({ workspace: second, expectedDraftRevision: 2, draft: { ...second.draft, objective: "Incomplete work" }, now });
  expect(third.draft.revision).toBe(3);
  expect(third.files).toEqual(second.files);
  expect(() => validateTasksetDraftWorkspace({ ...third, draft: { ...third.draft, objective: "tampered" } })).toThrow("retained bytes");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [original, original] })).toThrow("unique");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [original, { ...original, path: "private/input.bin/nested" }] })).toThrow("directory");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [{ ...original, base64: "AAA=" }] })).toThrow("retained bytes");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [{ ...original, path: "taskset.json" }] })).toThrow("draft document");
  const published = createTasksetDraftWorkspace({ schemaVersion: third.schemaVersion, files: third.files,
    draft: { ...third.draft, status: "published", publishedTasksetRef: { id: "release", revision: 1, contentHash: "a".repeat(64) } } });
  expect(() => saveTasksetDraftWorkspaceDocument({ workspace: published, expectedDraftRevision: 3, draft: published.draft, now })).toThrow("immutable");
});

// Saving an untouched code/binary file must preserve its admitted bytes, and
// a client must not bypass editor limits or write retained authoring history.
it("round-trips exact editor bytes and enforces canonical transport and managed paths", () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("export const grade = () => 1;\n"), new Uint8Array([239, 187, 191, 97]), new Uint8Array([0, 255, 128, 13, 10])]) {
    const file = createTasksetDraftFile("graders/source.ts", bytes);
    expect(file.contentHash).toBe(sha256(bytes));
    expect(decodeTasksetDraftFileContent(file.content)).toEqual(bytes);
  }
  expect(isWritableTasksetDraftFilePath("taskset.json")).toBe(false);
  expect(isWritableTasksetDraftFilePath("source-artifacts/revision/source.ts")).toBe(false);
  expect(() => isWritableTasksetDraftFilePath("nested/.env")).toThrow();
  expect(() => decodeTasksetDraftFileContent({ encoding: "base64", data: "AP8" })).toThrow();
  expect(() => createTasksetDraftFile("large.bin", new Uint8Array(MAX_TASKSET_DRAFT_EDIT_FILE_BYTES + 1))).toThrow();
  expect(() => decodeTasksetDraftFileContent({ encoding: "utf8", data: "a".repeat(MAX_TASKSET_DRAFT_EDIT_FILE_BYTES + 1) })).toThrow();
});
