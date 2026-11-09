import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LocalDatasetRecordSchema, type ChatResourceSummary, type LocalDatasetRecord, type TaskDataDraft, type TaskResourceContext } from "@openpond/contracts";
import { ApiRequestError } from "../../api/api-client";
import type { ClientConnection } from "../../api";
import { chatResourceRequest, type DatasetResponse } from "../../api/chat-resource-api";
import { connectionQueryScope } from "../../lib/query-scope";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { JsonObjectField } from "../datasets/TasksetDraftEditorPrimitives";
import { ListFilter } from "../icons";
import { useDraftNavigation } from "../labs/useDraftNavigation";

const splitOptions = [
  { value: "all", label: "All splits" },
  { value: "train", label: "Training" },
  { value: "validation", label: "Validation" },
  { value: "test", label: "Test" },
  { value: "frozen_eval", label: "Held-out evaluation" },
];

export function PonderDatasetTasks({ connection, dataset, onSaved }: {
  connection: ClientConnection; dataset: ChatResourceSummary; sessionId: string | null; contexts: TaskResourceContext[];
  onSaved: (summary: ChatResourceSummary) => Promise<void>;
}) {
  const query = useQuery({ queryKey: ["ponder-dataset", connectionQueryScope(connection), dataset.id, dataset.revision],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<DatasetResponse>(connection, "dataset", { action: "read", id: dataset.id, expectedRevision: dataset.revision }, signal);
      if (result.summary.id !== dataset.id || result.summary.revision !== dataset.revision) throw new Error("Dataset differs from the selected revision.");
      return LocalDatasetRecordSchema.parse(result.record);
    } });
  return <>
    <ErrorToast error={query.error}>{query.error ? <button type="button" onClick={() => void query.refetch()}>Retry tasks</button> : null}</ErrorToast>
    {query.isPending ? <p role="status">Loading tasks…</p> : query.data ? <TaskEditor key={`${dataset.id}:${dataset.revision}`} record={query.data}
      connection={connection} onSaved={onSaved} /> : null}
  </>;
}

function TaskEditor({ record, connection, onSaved }: {
  record: LocalDatasetRecord; connection: ClientConnection;
  onSaved: (summary: ChatResourceSummary) => Promise<void>;
}) {
  const [baseline, setBaseline] = useState(record.workspace.draft);
  const [draft, setDraft] = useState(baseline);
  const [split, setSplit] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ operationId: string; draft: typeof draft } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || Boolean(pending.current);
  const guard = useDraftNavigation({ name: "Dataset tasks", dirty, busy, onLeave: () => setDraft(baseline) });
  const rows = draft.tasks.filter(task => split === "all" || task.split === split);
  const splitLabel = splitOptions.find(option => option.value === split)!.label;
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const task = draft.tasks.find(item => item.id === selected);
  const disabled = busy || Boolean(pending.current);
  function update(value: TaskDataDraft) { setDraft(previous => ({ ...previous, tasks: previous.tasks.map(item => item.id === value.id ? value : item) })); }
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    const command = pending.current ?? { operationId: crypto.randomUUID(), draft };
    pending.current = command;
    try {
      const result = await chatResourceRequest<DatasetResponse>(connection, "dataset", {
        action: "save", id: baseline.id, expectedRevision: baseline.revision, operationId: command.operationId, payload: { draft: command.draft },
      });
      const saved = LocalDatasetRecordSchema.parse(result.record).workspace.draft;
      pending.current = null; setBaseline(saved); setDraft(saved);
      guard.allowNextNavigation();
      await onSaved(result.summary);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) pending.current = null;
      setError(cause instanceof Error ? cause.message : "Could not save dataset tasks.");
    }
    finally { setBusy(false); }
  }
  return <>
    {guard.dialog}<ErrorToast error={error} />
    {task ? <section className="ponder-task-inspector" aria-label={`Task ${task.id}`}>
      <header><h3>{task.id}</h3><button type="button" className="training-text-button" onClick={() => setSelected(null)}>Back to tasks</button></header>
      <JsonObjectField label="Input" value={task.input} disabled={disabled} onChange={input => { if (input) update({ ...task, input }); }} />
      <JsonObjectField label="Reference answer" nullable value={task.expectedOutput} disabled={disabled} onChange={expectedOutput => update({ ...task, expectedOutput })} />
      <DropdownSelect label="Task split" value={task.split} disabled={disabled} floating options={["train", "validation", "test", "frozen_eval"].map(value => ({ value, label: value === "frozen_eval" ? "Held-out evaluation" : value }))}
        onChange={value => update({ ...task, split: value as TaskDataDraft["split"] })} />
      <button type="button" className="training-button secondary" disabled={disabled} onClick={() => {
        setDraft(value => ({ ...value, tasks: value.tasks.filter(item => item.id !== task.id), graderFixtures: value.graderFixtures.filter(item => item.taskId !== task.id) })); setSelected(null);
      }}>Remove task</button>
    </section> : <>
      <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table ponder-task-table ponder-task-table-with-reference">
        <thead><tr><th>Task</th><th>Input</th><th>Reference</th><th><div className="ponder-split-heading">Split
          <DropdownSelect label={`Filter tasks by split: ${splitLabel}`} tooltip={splitLabel} floating floatingMenuWidth={200}
            className={`ponder-split-filter${split !== "all" ? " filtered" : ""}`} value={split} options={splitOptions}
            triggerContent={<ListFilter size={14} aria-hidden="true" />}
            onChange={value => { setSplit(value); setPage(0); }} />
        </div></th></tr></thead>
        <tbody>{rows.slice(current * 20, current * 20 + 20).map(item => <tr key={item.id}>
          <td><button type="button" className="training-text-button" onClick={() => setSelected(item.id)}>{item.id}</button></td>
          <td><span className="ponder-task-preview">{(typeof item.input.prompt === "string" ? item.input.prompt : JSON.stringify(item.input)).slice(0, 160)}</span></td>
          <td><span className="ponder-task-preview">{(typeof item.expectedOutput?.text === "string" ? item.expectedOutput.text : JSON.stringify(item.expectedOutput ?? {})).slice(0, 120)}</span></td><td>{item.split}</td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length ? <p>No tasks match this view.</p> : null}
      {rows.length > 20 ? <div className="training-rollout-pagination"><button type="button" disabled={!current} onClick={() => setPage(current - 1)}>Previous</button>
        <span>{current * 20 + 1}–{Math.min(rows.length, current * 20 + 20)} of {rows.length}</span><button type="button" disabled={(current + 1) * 20 >= rows.length} onClick={() => setPage(current + 1)}>Next</button></div> : null}
    </>}
    {dirty ? <div className="ponder-workbench-actions">
      <button type="button" className="training-button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : pending.current ? "Retry save" : "Save changes"}</button>
    </div> : null}
  </>;
}
