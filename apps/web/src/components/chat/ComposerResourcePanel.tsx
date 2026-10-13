import { MessageSquare } from "../icons";
import { useEffect, useState } from "react";
import type { DatasetResponse } from "../../api/chat-resource-api";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";

export type ResourcePanelKind = "experiment" | "new-experiment" | "action" | "dataset" | "grader" | "training" | "rows";
type Resources = ReturnType<typeof useChatResourceFocus>;

export function ComposerResourcePanel({ kind, resources, busy, onDraft }: {
  kind: Exclude<ResourcePanelKind, "experiment" | "new-experiment" | "action">; resources: Resources; busy: boolean; onDraft: (text: string) => void;
}) {
  const [description, setDescription] = useState("");
  if (kind === "rows") return <DatasetRows resources={resources} />;
  const dataset = resources.focus.dataset;
  const context = dataset ? `${dataset.name} V${dataset.revision}` : "the selected dataset";
  const labels = {
    dataset: {title:"New dataset", placeholder:"What examples should it contain?", button:"Add to chat"},
    grader: {title:"Create grader", placeholder:"What should the grader check?", button:"Add to chat"},
    training: {title:"Train on OpenPond", placeholder:"What should the model learn? (optional)", button:"Add to chat"},
  }[kind];
  function submit() {
    const detail = description.trim();
    const request = kind === "dataset" ? `Create a new dataset: ${detail}`
      : kind === "grader" ? `Create a grader for ${context}: ${detail}`
      : `Prepare hosted training on OpenPond for ${context}.${detail ? ` Goal: ${detail}.` : ""} Show me the model options, plan, and cost first.`;
    onDraft(request);
  }
  const disabled = busy || resources.selecting || kind !== "dataset" && !dataset || kind !== "training" && !description.trim();
  return <div className="composer-resource-request" onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); if (!disabled) submit(); } }}>
    <div className="composer-experiment-setup-heading"><strong>{labels.title}</strong></div>
    <input autoFocus aria-label={labels.placeholder} placeholder={labels.placeholder} value={description} onChange={event => setDescription(event.target.value)} disabled={busy} />
    <button type="button" className="composer-experiment-create" onClick={submit} disabled={disabled}><MessageSquare size={13} aria-hidden /> {labels.button}</button>
  </div>;
}

function DatasetRows({ resources }: {resources: Resources}) {
  const [record, setRecord] = useState<DatasetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setRecord(null); setError(null); setPage(0);
    void resources.readDataset(abort.signal).then(result => { if (!abort.signal.aborted) setRecord(result); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load dataset rows."); });
    return () => abort.abort();
  }, [resources.readDataset]);
  const tasks = record?.record.workspace.draft.tasks ?? [];
  const pages = Math.max(1, Math.ceil(tasks.length / 5));
  return <section className="composer-dataset-rows" aria-label="Dataset rows">
    <div className="composer-experiment-setup-heading"><strong>Dataset rows</strong><span>{record ? `${tasks.length} examples · V${record.summary.revision}` : ""}</span>
      {pages > 1 ? <div><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)} aria-label="Previous rows">‹</button><span>{page + 1}/{pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)} aria-label="Next rows">›</button></div> : null}
    </div>
    {error ? <p role="alert" className="chat-resource-error">{error}</p> : !record ? <p role="status">Loading rows…</p> : <div className="composer-dataset-rows-scroll"><table><thead><tr><th>Example</th><th>Input</th></tr></thead><tbody>
      {tasks.slice(page * 5, page * 5 + 5).map(task => <tr key={task.id}><td>{task.id}</td><td>{typeof task.input.prompt === "string" ? task.input.prompt : typeof task.input.request === "string" ? task.input.request : JSON.stringify(task.input)}</td></tr>)}
      {!tasks.length ? <tr><td colSpan={2}>No saved rows yet.</td></tr> : null}
    </tbody></table></div>}
  </section>;
}
