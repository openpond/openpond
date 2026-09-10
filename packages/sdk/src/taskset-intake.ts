import { contentHash } from "@openpond/harness";
import { previewTaskIntake, TaskIntakePreviewSchema, type TaskIntakePreview, type TaskIntakeFile } from "@openpond/evals/learning";
import { TaskDataDraftSchema, TasksetDraftSchema, type TasksetDraft } from "./taskset-draft-document.js";
import { createTasksetDraftFile } from "./taskset-draft-files.js";

/** Retained source files are unreferenced private assets during publication.
 * A manifest preserves upload filenames without granting them filesystem paths. */
export function taskIntakeSourceFiles(preview: TaskIntakePreview, files: TaskIntakeFile[]) {
  if (previewTaskIntake({ format: preview.format, files }).contentHash !== preview.contentHash) throw new Error("The source files differ from the import preview.");
  const directory = `private/intake/${preview.contentHash}`;
  const sources = files.map((file, index) => ({ file, path: `${directory}/${String(index).padStart(4, "0")}.txt` }));
  const manifest = { schemaVersion: "openpond.taskIntakeSources.v1", format: preview.format, previewHash: preview.contentHash,
    files: sources.map(({ file, path }) => ({ originalPath: file.path, retainedPath: path })) };
  return [...sources.map(({ file, path }) => createTasksetDraftFile(path, new TextEncoder().encode(file.text))),
    createTasksetDraftFile(`${directory}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)))];
}

/** Raw history stays in Labeling until its task and runtime are reviewed. */
export function appendTaskIntake(draft: TasksetDraft, raw: TaskIntakePreview, recordIds: string[]): TasksetDraft {
  const preview = TaskIntakePreviewSchema.parse(raw);
  if (!recordIds.length || new Set(recordIds).size !== recordIds.length) throw new Error("Select unique task records to import.");
  const tasks = [...draft.tasks];
  for (const id of recordIds) {
    const record = preview.records.find(record => record.id === id);
    if (!record || record.kind !== "task" || record.needsContext) throw new Error("Recorded attempts and incomplete histories must be imported into Labeling for review.");
    const task = TaskDataDraftSchema.parse({ schemaVersion: "openpond.taskData.v1", id: record.id, clusterKey: record.familyKey,
      split: record.split, input: record.input, expectedOutput: record.expected, privilegedContextRef: null,
      metadata: { intake: { format: preview.format, uploadHash: preview.contentHash, sourceId: record.sourceId, sourceHash: record.sourceHash, metadata: record.metadata } },
    });
    const existing = tasks.find(existing => existing.id === task.id);
    if (existing && contentHash(existing) !== contentHash(task)) throw new Error(`Task ${task.id} already exists with different content. Import will not replace saved edits.`);
    if (!existing) tasks.push(task);
  }
  const families = new Map<string, string>();
  for (const task of tasks) for (const key of [`family:${task.clusterKey}`, `input:${contentHash(task.input)}`]) {
    if (families.has(key) && families.get(key) !== task.split) throw new Error("The imported task family or request already occurs in another split.");
    families.set(key, task.split);
  }
  return TasksetDraftSchema.parse({ ...draft, tasks });
}
