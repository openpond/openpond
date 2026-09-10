import { expect, it } from "vitest";
import { previewTaskIntake } from "@openpond/evals/learning";
import { appendTaskIntake, taskIntakeSourceFiles } from "../src/taskset-intake.js";
import { decodeTasksetDraftFileContent } from "../src/taskset-draft-files.js";
import { createTasksetDraft } from "../src/taskset-draft-authoring.js";

// Retrying an upload must not duplicate tasks, overwrite edits, leak reference
// labels into requests, or silently turn an unreviewed trace into task data.
it("appends task imports idempotently while retaining private references and split boundaries", () => {
  const files = [{ path: "tasks.json", text: JSON.stringify({ instruction: "Request", reference: "private", labels: "unverified" }) }];
  const preview = previewTaskIntake({ format: "json", files });
  const retained = taskIntakeSourceFiles(preview, files);
  expect(retained.every(file => file.path.startsWith(`private/intake/${preview.contentHash}/`))).toBe(true);
  expect(new TextDecoder().decode(decodeTasksetDraftFileContent(retained[0]!.content))).toBe(files[0]!.text);
  expect(() => taskIntakeSourceFiles(preview, [{ ...files[0]!, text: "[]" }])).toThrow("differ");
  const ids = preview.records.map(record => record.id);
  const draft = appendTaskIntake(createTasksetDraft({ profileId: "profile" }), preview, ids);
  expect(appendTaskIntake(draft, preview, ids)).toEqual(draft);
  expect(draft.tasks[0]).toMatchObject({ input: { instruction: "Request" }, expectedOutput: { text: "private" }, metadata: { intake: { metadata: { importedLabels: "unverified" } } } });
  expect(() => appendTaskIntake({ ...draft, tasks: draft.tasks.map(task => ({ ...task, input: { instruction: "Edited" } })) }, preview, ids)).toThrow("different content");
  const heldOut = { ...draft, tasks: draft.tasks.map(task => ({ ...task, id: "held-out", split: "test" as const })) };
  expect(() => appendTaskIntake(heldOut, preview, ids)).toThrow("another split");
  const history = previewTaskIntake({ format: "hermes", files: [{ path: "session.jsonl", text: JSON.stringify({ id: "session", messages: [{ role: "user", content: "Request" }, { role: "assistant", content: "Reply" }] }) }] });
  expect(() => appendTaskIntake(draft, history, history.records.map(record => record.id))).toThrow("Labeling");
});
