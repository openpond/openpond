import { useEffect, useRef, useState } from "react";
import { contentHash } from "@openpond/harness";
import { previewTaskIntake, TASK_INTAKE_LIMITS, LearningSourceSchema, type OpenPondLearningClient,
  type TaskIntakeFile, type TaskIntakeFormat, type TaskIntakePreview } from "openpond-sdk/learning";
import { LearningError } from "./LearningFields";

export type TaskIntakeSelection = { preview: TaskIntakePreview; files: TaskIntakeFile[]; recordIds: string[]; name: string; signal: AbortSignal };
export function TaskIntakeForm({ client, initialFormat = "json", onTasks, onImported, onBack, onBusyChange }: {
  client: OpenPondLearningClient | null; initialFormat?: TaskIntakeFormat;
  onTasks: (input: TaskIntakeSelection) => Promise<void>; onImported: (sourceId: string) => void;
  onBack: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [format, setFormat] = useState(initialFormat);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<TaskIntakeFile[]>([]);
  const [preview, setPreview] = useState<TaskIntakePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const records = preview?.records.filter(record => selected.has(record.id)) ?? [];
  const labeling = records.some(record => record.kind === "attempt" || record.needsContext);
  function pending(value: boolean) { setBusy(value); onBusyChange(value); }
  async function readFiles(list: FileList | null) {
    if (!list?.length) return;
    setError(null); setPreview(null); setProgress(0); pending(true);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const incoming = Array.from(list);
      if (incoming.length > TASK_INTAKE_LIMITS.files || incoming.reduce((bytes, file) => bytes + file.size, 0) > TASK_INTAKE_LIMITS.bytes) throw new Error("Choose at most 100 files totaling 5 MiB.");
      const next = await Promise.all(incoming.map(async file => ({ path: file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name, text: await file.text() })));
      controller.signal.throwIfAborted();
      const result = previewTaskIntake({ format, files: next });
      setFiles(next); setPreview(result); setSelected(new Set(result.records.map(record => record.id))); setPage(0);
      if (!name) setName(incoming[0]!.webkitRelativePath?.split("/")[0] || incoming[0]!.name.replace(/\.[^.]+$/u, ""));
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not read the import."); }
    finally { if (!controller.signal.aborted) pending(false); }
  }
  async function save() {
    if (!preview || !records.length) return;
    pending(true); setError(null); setProgress(0);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const recordIds = records.map(record => record.id);
      if (!labeling) { await onTasks({ preview, files, recordIds, name, signal: controller.signal }); return; }
      if (!client) throw new Error("Connect to this workspace before importing attempts.");
      let sourceId = "";
      for (let offset = 0; offset < recordIds.length; offset += 90) {
        controller.signal.throwIfAborted();
        const chunk = recordIds.slice(offset, offset + 90);
        const response = await client.command({ action: "import_intake", operationId: `intake-${contentHash([preview.contentHash, chunk])}`,
          format, files, expectedPreviewHash: preview.contentHash, name, recordIds: chunk }, { signal: controller.signal });
        sourceId = LearningSourceSchema.parse(response.resources[0]).id;
        setProgress(Math.min(offset + chunk.length, recordIds.length));
      }
      controller.signal.throwIfAborted();
      onImported(sourceId);
    } catch (error) { setError(error instanceof Error ? error.message : "Import failed. Retry the same selection to resume without duplicates."); }
    finally { if (!controller.signal.aborted) pending(false); }
  }
  return <fieldset disabled={busy} className="learning-workspace">
    <h2>Import tasks and histories</h2><p>Preview supported files before saving. Imported attempts go to Labeling; task instructions become a saved draft.</p>
    <LearningError error={error} />
    <label>Source format<select value={format} onChange={event => { setFormat(event.target.value as TaskIntakeFormat); setPreview(null); setFiles([]); setSelected(new Set()); setProgress(0); }}>
      <option value="json">JSON tasks</option><option value="jsonl">JSONL tasks</option><option value="csv">CSV tasks</option><option value="hermes">Hermes native session JSONL</option><option value="openclaw">OpenClaw trajectory folder</option>
    </select></label>
    <p>{format === "openclaw" ? "Select the exported trajectory folder containing manifest.json, events.jsonl and session-branch.json. Context files are retained as source evidence." : format === "hermes" ? "Use the native Hermes sessions export: one session with its messages per JSONL line." : 'Use instruction, optional context, reference, labels, id, familyKey and split. JSON also accepts structured input, expectedOutput and observedOutput objects.'}</p>
    <label>{format === "openclaw" ? "Trajectory folder" : "Import files"}<input key={format} type="file" multiple accept={format === "openclaw" ? undefined : format === "csv" ? ".csv" : format === "json" ? ".json" : ".jsonl,.json"} {...(format === "openclaw" ? { webkitdirectory: "" } : {})} onChange={event => { void readFiles(event.target.files); }} /></label>
    <label>Collection name<input value={name} maxLength={500} onChange={event => setName(event.target.value)} /></label>
    {preview ? <>
      {preview.issues.length ? <details open><summary>{preview.issues.length} invalid records or files</summary><ul>{preview.issues.map((issue, index) => <li key={index}>{issue.file}{issue.row ? ` · row ${issue.row}` : ""}: {issue.message}</li>)}</ul></details> : null}
      <label><input type="checkbox" checked={selected.size === preview.records.length && selected.size > 0} onChange={event => setSelected(new Set(event.target.checked ? preview.records.map(record => record.id) : []))} />Select all valid records</label>
      <ul className="learning-list">{preview.records.slice(page * 20, (page + 1) * 20).map(record => <li key={record.id}>
        <label><input type="checkbox" checked={selected.has(record.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(record.id); else next.delete(record.id); return next; })} />{intakeText(record.input).slice(0, 160) || record.sourceId} · {record.kind} · {record.split}</label>
        <details><summary>Preview request and context</summary><IntakeValue value={record.input} />{record.expected ? <><h3>Private reference</h3><IntakeValue value={record.expected} /></> : null}{record.observedOutput ? <><h3>Recorded response</h3><IntakeValue value={record.observedOutput} /></> : null}</details>
        {record.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      </li>)}</ul>
      {preview.records.length > 20 ? <nav aria-label="Import preview pages"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(preview.records.length / 20)}</span><button type="button" disabled={(page + 1) * 20 >= preview.records.length} onClick={() => setPage(page + 1)}>Next</button></nav> : null}
      <p>{records.length} selected. {labeling ? "These records will wait in Labeling for context review and Reward selection." : "Tasks will be saved as a draft. References remain evaluator-only."}</p>
    </> : null}
    {progress ? <p role="status">{progress} records saved. A retry resumes the same import.</p> : null}
    <div className="learning-actions"><button type="button" className="training-button secondary" onClick={onBack}>Back</button><button type="button" className="training-button" disabled={!name.trim() || !records.length} onClick={() => { void save(); }}>{busy ? "Importing…" : labeling ? "Import for labeling" : "Import tasks"}</button></div>
  </fieldset>;
}

function intakeText(value: Record<string, unknown>): string {
  return ["instruction", "request", "prompt", "question", "response", "text", "answer"].flatMap(key => typeof value[key] === "string" ? [value[key]] : []).join("\n");
}
function IntakeValue({ value }: { value: Record<string, unknown> }) {
  return <div><p style={{ whiteSpace: "pre-wrap" }}>{intakeText(value) || "This record contains structured context."}</p>
    {typeof value.context === "string" ? <p style={{ whiteSpace: "pre-wrap" }}>{value.context}</p> : null}
    <details><summary>Structured source fields</summary><pre>{JSON.stringify(value, null, 2)}</pre></details></div>;
}
