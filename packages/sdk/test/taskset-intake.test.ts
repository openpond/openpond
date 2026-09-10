import { expect, it } from "vitest";
import { previewTaskIntake } from "@openpond/evals/learning";
import { appendTaskIntake } from "../src/taskset-intake.js";
import { createTasksetDraft } from "../src/taskset-draft-authoring.js";

// Retrying an upload must not duplicate tasks, overwrite edits, leak reference
// labels into requests, or silently turn an unreviewed trace into task data.
it("appends task imports idempotently while retaining private references and split boundaries", () => {
  const preview = previewTaskIntake({ format: "json", files: [{ path: "tasks.json", text: JSON.stringify({ instruction: "Request", reference: "private", labels: "unverified" }) }] });
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
