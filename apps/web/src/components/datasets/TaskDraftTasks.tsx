import { useState } from "react";
import type { TaskDataDraft, TasksetDraft } from "@openpond/contracts";
import { AppDialog } from "../dialogs/AppDialog";
import { EditorSection, EmptyState, Field, JsonArrayField, JsonObjectField } from "./TasksetDraftEditorPrimitives";
import { TasksetSplitBuilder } from "./TasksetSplitBuilder";
import { newTask, parseStringArray } from "./taskset-draft-editor-helpers";

const PAGE_SIZE = 25;

export function TaskDraftTasks({ draft, disabled, onChange }: { draft: TasksetDraft; disabled: boolean; onChange: (draft: TasksetDraft) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requestedPage, setPage] = useState(0);
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(draft.tasks.length / PAGE_SIZE) - 1));
  const tasks = draft.tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = draft.tasks.find(task => task.id === selectedId);
  function update(task: TaskDataDraft) {
    onChange({ ...draft, tasks: draft.tasks.map(candidate => candidate.id === task.id ? task : candidate) });
  }
  function remove(task: TaskDataDraft) {
    onChange({ ...draft, tasks: draft.tasks.filter(candidate => candidate.id !== task.id), graderFixtures: draft.graderFixtures.filter(fixture => fixture.taskId !== task.id) });
    setSelectedId(null);
  }
  return <EditorSection title="Tasks" description="Edit the task input, context, private reference, and split." action={<button className="training-button" disabled={disabled} type="button" onClick={() => {
    const task = newTask();
    onChange({ ...draft, tasks: [...draft.tasks, task] });
    setPage(Math.floor(draft.tasks.length / PAGE_SIZE));
    setSelectedId(task.id);
  }}>Add task</button>}>
    <details><summary>Build tasks from text</summary><TasksetSplitBuilder disabled={disabled} objective={draft.objective} onCreate={tasks => onChange({ ...draft, tasks: [...draft.tasks, ...tasks] })} /></details>
    {tasks.length ? <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Task</th><th>Split</th><th>Reference</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}>
      <td><button className="labs-version-row-button" type="button" onClick={() => setSelectedId(task.id)}>{taskText(task.input) || task.id}</button></td><td>{task.split.replaceAll("_", " ")}</td><td>{task.expectedOutput ? "Private reference" : "None"}</td>
    </tr>)}</tbody></table></div> : <EmptyState>Add a task when you are ready. You can save an empty collection.</EmptyState>}
    {draft.tasks.length > PAGE_SIZE ? <nav className="labs-pagination" aria-label="Draft tasks"><button disabled={!page} type="button" onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} of {Math.ceil(draft.tasks.length / PAGE_SIZE)}</span><button disabled={(page + 1) * PAGE_SIZE >= draft.tasks.length} type="button" onClick={() => setPage(page + 1)}>Next</button></nav> : null}
    {selected ? <AppDialog ariaLabel="Edit task" className="labs-rename-dialog labs-model-create-dialog" backdropClassName="labs-rename-backdrop" onClose={() => setSelectedId(null)}>
      <header><h2>Edit task</h2><button className="training-button secondary" type="button" onClick={() => setSelectedId(null)}>Done</button></header>
      <TaskTextField label="Input" value={selected.input} disabled={disabled} onChange={input => update({ ...selected, input })} />
      <Field label="Split"><select value={selected.split} disabled={disabled} onChange={event => update({ ...selected, split: event.target.value as TaskDataDraft["split"] })}><option value="train">Training</option><option value="validation">Validation</option><option value="test">Test</option><option value="frozen_eval">Held-out evaluation</option></select></Field>
      <TaskTextField label="Private reference answer" value={selected.expectedOutput ?? { text: "" }} defaultKey="text" disabled={disabled} onChange={expectedOutput => update({ ...selected, expectedOutput })} />
      <details><summary>Context, files, and task identity</summary>
        <JsonObjectField label="Policy-visible context" value={selected.policyVisibleContext ?? {}} disabled={disabled} onChange={policyVisibleContext => update({ ...selected, policyVisibleContext: policyVisibleContext ?? {} })} />
        <JsonArrayField label="Asset references" value={selected.assets ?? []} disabled={disabled} onChange={assets => update({ ...selected, assets: assets as TaskDataDraft["assets"] })} />
        <Field label="Resource IDs"><input disabled={disabled} value={(selected.resourceRefs ?? []).join(", ")} onChange={event => update({ ...selected, resourceRefs: parseStringArray(event.target.value) })} /></Field>
        <Field label="Task family"><input disabled={disabled} value={selected.clusterKey} onChange={event => update({ ...selected, clusterKey: event.target.value })} /></Field>
        <p>Task ID: {selected.id}</p>
      </details>
      <button className="training-text-button danger" type="button" disabled={disabled} onClick={() => remove(selected)}>Remove task</button>
    </AppDialog> : null}
  </EditorSection>;
}

function textKey(value: Record<string, unknown>) {
  return ["prompt", "instruction", "request", "question", "message", "text"].find(key => typeof value[key] === "string");
}
function taskText(value: Record<string, unknown>) { const key = textKey(value); return key ? String(value[key]).slice(0, 180) : ""; }
function TaskTextField({ label, value, defaultKey = "prompt", disabled, onChange }: { label: string; value: Record<string, unknown>; defaultKey?: string; disabled: boolean; onChange: (value: Record<string, unknown>) => void }) {
  const key = textKey(value) ?? (Object.keys(value).length === 0 ? defaultKey : null);
  return <div>{key ? <Field label={label}><textarea rows={5} disabled={disabled} value={typeof value[key] === "string" ? value[key] : ""} onChange={event => onChange({ ...value, [key]: event.target.value })} /></Field> : <p>{label} uses structured fields.</p>}
    <details><summary>{label}: structured fields</summary><JsonObjectField disabled={disabled} label={label} value={value} onChange={next => onChange(next ?? {})} /></details>
  </div>;
}
