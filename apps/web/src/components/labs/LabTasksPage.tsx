import { ModelsPageSearch } from "./ModelsPageSearch";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectionQueryScope } from "../../lib/query-scope";
import type { TrainingStateResponse } from "@openpond/contracts";
import type { TaskInventoryItem } from "openpond-sdk/taskset-drafts";
import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { ModelTasksetDraftAction } from "./ModelTasksetDraftAction";
import { ReadableTaskValue } from "./ReadableTaskValue";

const status = { configured: "Configured", needs_reward: "Needs grader", needs_checks: "Needs checks" };
const methods = { code: "Code checks", judge: "LLM judge", human: "Human review" };

export function LabTasksPage({ state, training, modelId, collectionId, query, after, onSearch, onPage, onCollection, onAdd, onOpenDraft }: {
  state: TrainingStateResponse | null; training: ReturnType<typeof useTraining>; modelId: string | null; collectionId: string | null;
  query: string; after: string | null; onSearch: (value: string) => void; onPage: (value: string | null) => void; onCollection: (value: string | null) => void;
  onAdd: () => void; onOpenDraft: (id: string) => void;
}) {
  const [split, setSplit] = useState<"train" | "validation" | "test" | "frozen_eval" | "">("");
  const [selected, setSelected] = useState<TaskInventoryItem | null>(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const request = { projectId: modelId ?? undefined, tasksetId: collectionId ?? undefined, query, after: after ?? undefined, split: split || undefined };
  const result = useQuery({ queryKey: ["task-inventory", connectionQueryScope(training.connection), state?.profileId, "list", request],
    enabled: Boolean(training.connection && state), queryFn: () => training.actions.taskInventory(request) });
  const current = result.data ? { page: result.data, error: null } : result.error ? { page: null, error: result.error.message } : null;
  const drafts = state?.tasksetDrafts.filter(draft => draft.profileId === state.profileId && draft.status !== "published" && (!modelId || draft.modelScope?.modelId === modelId)) ?? [];
  return <div className="labs-flat-body labs-resource-page">
    <ModelProjectPageHeader title="Tasks" description="" actions={<><ModelsPageSearch label="Search tasks" value={query} onSearch={value => { setSelected(null); onSearch(value); }} /><button className="training-button secondary" type="button" onClick={() => setDraftsOpen(true)}>Saved drafts</button><button className="training-button" type="button" onClick={onAdd}>Add tasks</button></>} />
    <div className="labs-workproduct-toolbar">
      <label>Split<select value={split} onChange={event => { setSelected(null); setSplit(event.target.value as typeof split); onPage(null); }}><option value="">All splits</option><option value="train">Training</option><option value="validation">Validation</option><option value="test">Test</option><option value="frozen_eval">Held-out evaluation</option></select></label>
      {collectionId ? <button className="training-button secondary" type="button" onClick={() => onCollection(null)}>Clear collection filter</button> : null}
    </div>
    {current?.error ? <p role="alert">{current.error}</p> : !current ? <p role="status">Loading tasks…</p> : <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Task</th><th>Collection</th><th>Split</th><th>How scored</th><th>Status</th></tr></thead><tbody>{current.page?.items.map(item => <tr key={`${item.draftId ? "draft" : "release"}:${item.tasksetId}:${item.taskId}`}>
      <td><button className="labs-version-row-button" type="button" onClick={() => setSelected(item)}>{item.title}</button></td>
      <td><button className="labs-version-row-button" type="button" onClick={() => onCollection(item.tasksetId)}>{item.tasksetName || "Untitled tasks"}<small>{item.draftId ? "Draft" : "Published"} · revision {item.tasksetRevision}</small></button></td>
      <td>{item.split.replaceAll("_", " ")}</td><td>{[...new Set(item.scoring.map(score => methods[score.method]))].join(", ") || "Not configured"}</td><td>{status[item.configuration]}</td>
    </tr>)}{!current.page?.items.length ? <tr><td colSpan={5}>No tasks match this view.</td></tr> : null}</tbody></table></div>}
    <div className="model-build-actions">{after ? <button className="training-button secondary" type="button" onClick={() => onPage(null)}>First page</button> : null}{current?.page?.nextCursor ? <button className="training-button secondary" type="button" onClick={() => onPage(current.page!.nextCursor)}>Next page</button> : null}</div>
    {selected ? <TaskDetail key={`${selected.tasksetId}:${selected.taskId}:${selected.tasksetHash}`} item={selected} modelId={modelId} state={state} training={training} onClose={() => setSelected(null)} onOpenDraft={onOpenDraft} /> : null}
    {draftsOpen ? <AppDialog ariaLabel="Saved task drafts" className="labs-rename-dialog labs-model-create-dialog" backdropClassName="labs-rename-backdrop" onClose={() => setDraftsOpen(false)}><header><h2>Saved drafts</h2><button className="training-button secondary" type="button" onClick={() => setDraftsOpen(false)}>Close</button></header>{drafts.length ? <ul>{drafts.map(draft => <li key={draft.id}><button className="labs-version-row-button" type="button" onClick={() => onOpenDraft(draft.id)}>{draft.name || "Untitled tasks"} · {draft.tasks.length} tasks</button></li>)}</ul> : <p>No saved drafts in this view.</p>}</AppDialog> : null}
  </div>;
}

function TaskDetail({ item, modelId, state, training, onClose, onOpenDraft }: { item: TaskInventoryItem; modelId: string | null; state: TrainingStateResponse | null; training: ReturnType<typeof useTraining>; onClose: () => void; onOpenDraft: (id: string) => void }) {
  const request = { projectId: modelId ?? undefined, tasksetId: item.tasksetId, draftId: item.draftId ?? undefined, taskId: item.taskId };
  const result = useQuery({ queryKey: ["task-inventory", connectionQueryScope(training.connection), state?.profileId, "detail", request, item.tasksetHash],
    enabled: Boolean(training.connection && state), queryFn: async () => {
      const result = await training.actions.taskInventoryDetail(request);
      if (result.item.tasksetHash !== item.tasksetHash) throw new Error("This task changed. Reopen it from the updated list.");
      return result;
    } });
  const detail = result.data ?? null;
  const error = result.error?.message ?? null;
  const model = state?.modelProjects.find(model => model.id === modelId);
  return <AppDialog ariaLabel="Task details" className="labs-rename-dialog labs-model-create-dialog" backdropClassName="labs-rename-backdrop" onClose={onClose}>
    <header><div><h2>{item.title}</h2><p>{item.tasksetName} · revision {item.tasksetRevision}</p></div><button className="training-button secondary" type="button" onClick={onClose}>Close</button></header>
    {error ? <p role="alert">{error}</p> : !detail ? <p role="status">Loading task…</p> : <>
      <section><h3>Input</h3><ReadableTaskValue value={detail.task.input} /></section>
      {Object.keys(detail.task.policyVisibleContext ?? {}).length ? <section><h3>Context</h3><ReadableTaskValue value={detail.task.policyVisibleContext} /></section> : null}
      {detail.task.assets?.length ? <section><h3>Files</h3><ReadableTaskValue value={detail.task.assets} /></section> : null}
      <section><h3>How scored</h3>{item.scoring.length ? <ul>{item.scoring.map(score => <li key={score.id}>{methods[score.method]} · {score.id}{score.required ? " · Required" : ""}</li>)}</ul> : <p>No grader configured.</p>}</section>
      {detail.task.expectedOutput ? <details><summary>Private reference answer</summary><ReadableTaskValue value={detail.task.expectedOutput} /></details> : null}
      {item.draftId ? <button className="training-button" type="button" onClick={() => onOpenDraft(item.draftId!)}>Edit tasks</button> : model?.trainingSetup.tasksetRef?.contentHash === item.tasksetHash ? <ModelTasksetDraftAction model={model} training={training} onOpen={onOpenDraft} /> : null}
      <details><summary>Release details</summary><ReadableTaskValue value={{ taskId: item.taskId, contentHash: item.tasksetHash, family: detail.task.clusterKey, sources: detail.task.sourceRefs }} /></details>
    </>}
  </AppDialog>;
}
