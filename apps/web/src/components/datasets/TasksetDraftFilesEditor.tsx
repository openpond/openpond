import { lazy, Suspense, useRef, useState } from "react";
import type { TasksetDraft } from "@openpond/contracts";
import type { TasksetDraftFile, TasksetDraftFileInfo } from "openpond-sdk/model-taskset-authoring";
import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { useDraftNavigation } from "../labs/useDraftNavigation";

const CodeEditor = lazy(() => import("../workspace-diff/WorkspaceMonacoEditor"));

export function TasksetDraftFilesEditor({ draft, initialFiles, training, onSaved, onClose }: {
  draft: TasksetDraft; initialFiles: TasksetDraftFileInfo[]; training: ReturnType<typeof useTraining>;
  onSaved: (draft: TasksetDraft, notice?: string) => void; onClose: () => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [selected, setSelected] = useState<TasksetDraftFile | null>(null);
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState<TasksetDraftFile["content"]>({ encoding: "utf8", data: "" });
  const [newFile, setNewFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [recovery, setRecovery] = useState<{ draft: TasksetDraft; files: TasksetDraftFileInfo[]; file: TasksetDraftFile | null } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const writable = draft.status !== "published" && (newFile || selected?.writable === true);
  const dirty = writable && (newFile ? Boolean(filePath || content.data) : JSON.stringify(content) !== JSON.stringify(selected?.content));
  const guard = useDraftNavigation({ name: "file changes", dirty, busy, save: () => save(false) });

  async function open(relative: string) {
    if (active.current) return;
    active.current = true; setBusy(true); setError(null);
    try {
      const result = await training.actions.tasksetDraftFile(draft.id, relative);
      if (!result) throw new Error("The file could not be opened. Reload the latest draft to retry.");
      if (result.draftRevision !== draft.revision) throw new Error("The draft changed in another editor. Reload the draft before editing its files.");
      setSelected(result.file); setFilePath(result.file.path); setContent(result.file.content); setNewFile(false); setDeleteConfirm(false);
    } catch (error) { setError(error instanceof Error ? error.message : "The file could not be opened."); setNeedsReload(true); }
    finally { active.current = false; setBusy(false); }
  }

  async function save(remove: boolean): Promise<boolean> {
    if (active.current || needsReload || recovery || !writable || !filePath) return false;
    active.current = true; setBusy(true); setError(null);
    try {
      const saved = await training.actions.saveTasksetDraftFile({ draftId: draft.id, expectedDraftRevision: draft.revision, path: filePath,
        expectedFileHash: newFile ? null : selected!.contentHash, content: remove ? null : content });
      if (!saved) throw new Error("The file was not saved. Your edits are retained. Reload the latest draft before trying again.");
      onSaved(saved); setNewFile(false); setDeleteConfirm(false);
      if (remove) { setSelected(null); setFilePath(""); setContent({ encoding: "utf8", data: "" }); }
      else {
        const result = await training.actions.tasksetDraftFile(saved.id, filePath);
        if (!result || result.draftRevision !== saved.revision) throw new Error("Your file was saved, but its current revision could not be confirmed. Your edits are retained; reload the latest draft.");
        setSelected(result.file); setContent(result.file.content);
      }
      const list = await training.actions.tasksetDraftFiles(saved.id);
      if (!list || list.draftRevision !== saved.revision) throw new Error("Your file was saved, but the draft changed again or could not be read. Reload the latest draft.");
      setFiles(list.files);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "The file could not be saved."); setNeedsReload(true); return false; }
    finally { active.current = false; setBusy(false); }
  }

  async function reload() {
    if (active.current) return;
    active.current = true; setBusy(true); setError(null);
    try {
      const state = await training.refresh();
      const latest = state?.tasksetDrafts.find(candidate => candidate.id === draft.id);
      if (!latest) throw new Error("The draft is unavailable. Your edits are still retained here.");
      const list = await training.actions.tasksetDraftFiles(draft.id);
      if (!list || list.draftRevision !== latest.revision) throw new Error("The draft changed while reloading. Retry to read its current revision.");
      const result = filePath && list.files.some(file => file.path === filePath)
        ? await training.actions.tasksetDraftFile(draft.id, filePath) : null;
      if (filePath && list.files.some(file => file.path === filePath) && (!result || result.draftRevision !== latest.revision)) throw new Error("The file changed while reloading. Retry to read its current revision.");
      setRecovery({ draft: latest, files: list.files, file: result?.file ?? null });
    } catch (error) { setError(error instanceof Error ? error.message : "The draft could not be reloaded."); }
    finally { active.current = false; setBusy(false); }
  }

  function resolveRecovery(keepEdits: boolean) {
    if (!recovery || busy) return;
    onSaved(recovery.draft, keepEdits ? "Latest draft loaded. File edits still need saving." : "Latest saved draft loaded.");
    setFiles(recovery.files); setSelected(recovery.file); setNewFile(keepEdits && !recovery.file);
    if (!keepEdits) { setFilePath(recovery.file?.path ?? ""); setContent(recovery.file?.content ?? { encoding: "utf8", data: "" }); }
    setDeleteConfirm(false); setNeedsReload(false); setRecovery(null); setError(null);
  }

  return <><AppDialog ariaLabel="Taskset draft files" className="taskset-draft-files-dialog" dismissDisabled={busy} onClose={() => { void guard.requestLeave(onClose); }}>
    <header><div><h2>Taskset files</h2><p>Edit code and dependencies. Generated manifests are managed by the draft forms.</p></div><button className="training-button secondary" type="button" disabled={busy} onClick={() => { void guard.requestLeave(onClose); }}>Done</button></header>
    {error ? <p role="alert">{error}</p> : null}
    {needsReload ? <button className="training-button secondary" type="button" disabled={busy} onClick={() => { void reload(); }}>Reload latest draft</button> : null}
    {recovery ? <section aria-label="Resolve file changes">
      <p>{recovery.draft.status === "published" ? "This draft has been published and is now read only." : `Loaded draft revision ${recovery.draft.revision}. Choose which file content to keep; your edits remain in the editor below.`}</p>
      {recovery.file ? <details><summary>Current saved file</summary>{recovery.file.content.encoding === "utf8"
        ? <pre className="taskset-draft-file-readonly">{recovery.file.content.data}</pre> : <p>Binary file · {recovery.file.sizeBytes.toLocaleString()} bytes</p>}</details> : <p>This file is absent from the saved draft.</p>}
      <div className="taskset-draft-inline-actions">
        <button className="training-button secondary" type="button" disabled={busy} onClick={() => resolveRecovery(false)}>Use saved file</button>
        <button className="training-button" type="button" disabled={busy || !filePath || recovery.draft.status === "published" || recovery.file?.writable === false} onClick={() => resolveRecovery(true)}>Keep my edits</button>
      </div>
    </section> : null}
    <div className="taskset-draft-files-layout">
      <aside aria-label="Draft file list"><button className="training-button secondary" type="button" disabled={busy || needsReload || draft.status === "published"} onClick={() => { void guard.requestLeave(() => {
        setNewFile(true); setSelected(null); setFilePath(""); setContent({ encoding: "utf8", data: "" }); setDeleteConfirm(false); setError(null);
      }); }}>New file</button>
        {files.map(file => <button key={file.path} className={file.path === selected?.path ? "active" : ""} type="button" disabled={busy || needsReload || file.sizeBytes > 6_000_000} title={`${file.path} · ${file.sizeBytes.toLocaleString()} bytes${file.sizeBytes > 6_000_000 ? " · exceeds the 6 MB editor limit" : ""}`} onClick={() => { void guard.requestLeave(() => { void open(file.path); }); }}>{file.path}{!file.writable ? " · read only" : ""}</button>)}
      </aside>
      <section aria-label="File editor">
        {selected || newFile ? <>
          <div className="taskset-draft-file-actions">
            {newFile ? <label>File path<input value={filePath} disabled={busy || needsReload} onChange={event => setFilePath(event.target.value)} placeholder="graders/verify.js" /></label> : <strong>{filePath}</strong>}
            <button className="training-button" type="button" disabled={busy || needsReload || !writable || !filePath || !dirty} onClick={() => { void save(false); }}>Save file</button>
            {selected?.writable && draft.status !== "published" ? <button className="training-text-button" type="button" disabled={busy || needsReload} onClick={() => setDeleteConfirm(true)}>Delete file</button> : null}
            {writable ? <label>Replace with file<input type="file" disabled={busy} onChange={async event => {
              const file = event.target.files?.[0]; event.target.value = "";
              if (!file) return;
              if (file.size > 6_000_000) { setError("Choose a file no larger than 6 MB."); return; }
              active.current = true; setBusy(true); setError(null);
              const reader = new FileReader();
              reader.onerror = () => setError("The selected file could not be read.");
              reader.onload = () => { setContent({ encoding: "base64", data: String(reader.result).split(",")[1]! }); if (newFile && !filePath) setFilePath(`assets/${file.name}`); };
              reader.onloadend = () => { active.current = false; setBusy(false); };
              reader.readAsDataURL(file);
            }} /></label> : null}
          </div>
          {deleteConfirm ? <div role="alert"><p>Delete {filePath}? Publication will reject any remaining references to this file.</p><button type="button" className="training-button secondary" disabled={busy} onClick={() => setDeleteConfirm(false)}>Keep file</button><button type="button" className="training-button" disabled={busy} onClick={() => { void save(true); }}>Delete this file</button></div> : null}
          {content.encoding === "base64" ? <p>Binary file. Its exact bytes are retained when publishing. Use “Replace with file” to change it.</p>
            : writable ? <div className="taskset-draft-code"><Suspense fallback={<p>Loading code editor…</p>}><CodeEditor key={newFile ? "new-file" : filePath} filePath={`${draft.id}/${newFile ? "untitled.txt" : filePath}`} value={content.data} wordWrap={false} readOnly={busy} onChange={data => setContent({ encoding: "utf8", data })} onSave={() => { void save(false); }} /></Suspense></div>
              : <pre className="taskset-draft-file-readonly">{content.data}</pre>}
        </> : <p>Select a file to view its contents, or create a code or dependency file.</p>}
      </section>
    </div>
  </AppDialog>{guard.dialog}</>;
}
