import { lazy, Suspense, useRef, useState } from "react";
import type { TasksetDraft } from "@openpond/contracts";
import type { TasksetDraftFile, TasksetDraftFileInfo } from "openpond-sdk/model-taskset-authoring";
import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { useDraftNavigation } from "../labs/useDraftNavigation";

const CodeEditor = lazy(() => import("../workspace-diff/WorkspaceMonacoEditor"));

export function TasksetDraftFilesEditor({ draft, initialFiles, training, onSaved, onClose }: {
  draft: TasksetDraft; initialFiles: TasksetDraftFileInfo[]; training: ReturnType<typeof useTraining>;
  onSaved: (draft: TasksetDraft) => void; onClose: () => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  const [selected, setSelected] = useState<TasksetDraftFile | null>(null);
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState<TasksetDraftFile["content"]>({ encoding: "utf8", data: "" });
  const [newFile, setNewFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const writable = draft.status !== "published" && (newFile || selected?.writable === true);
  const dirty = writable && (newFile ? Boolean(filePath || content.data) : JSON.stringify(content) !== JSON.stringify(selected?.content));
  const guard = useDraftNavigation({ name: "file changes", dirty, busy, save: () => save(false) });

  async function open(relative: string) {
    if (active.current) return;
    active.current = true; setBusy(true); setError(null);
    try {
      const result = await training.actions.tasksetDraftFile(draft.id, relative);
      if (!result) return;
      if (result.draftRevision !== draft.revision) throw new Error("The draft changed in another editor. Reload the draft before editing its files.");
      setSelected(result.file); setFilePath(result.file.path); setContent(result.file.content); setNewFile(false); setDeleteConfirm(false);
    } catch (error) { setError(error instanceof Error ? error.message : "The file could not be opened."); }
    finally { active.current = false; setBusy(false); }
  }

  async function save(remove: boolean): Promise<boolean> {
    if (active.current || !writable || !filePath) return false;
    active.current = true; setBusy(true); setError(null);
    try {
      const saved = await training.actions.saveTasksetDraftFile({ draftId: draft.id, expectedDraftRevision: draft.revision, path: filePath,
        expectedFileHash: newFile ? null : selected!.contentHash, content: remove ? null : content });
      if (!saved) return false;
      onSaved(saved); setNewFile(false); setDeleteConfirm(false);
      if (remove) { setSelected(null); setFilePath(""); setContent({ encoding: "utf8", data: "" }); }
      else {
        const result = await training.actions.tasksetDraftFile(saved.id, filePath);
        if (result) { setSelected(result.file); setContent(result.file.content); }
      }
      const list = await training.actions.tasksetDraftFiles(saved.id);
      if (list) setFiles(list.files);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "The file could not be saved."); return false; }
    finally { active.current = false; setBusy(false); }
  }

  return <><AppDialog ariaLabel="Taskset draft files" className="taskset-draft-files-dialog" dismissDisabled={busy} onClose={() => { void guard.requestLeave(onClose); }}>
    <header><div><h2>Taskset files</h2><p>Edit code and dependencies. Generated manifests are managed by the draft forms.</p></div><button className="training-button secondary" type="button" disabled={busy} onClick={() => { void guard.requestLeave(onClose); }}>Done</button></header>
    {error ? <p role="alert">{error}</p> : null}
    <div className="taskset-draft-files-layout">
      <aside aria-label="Draft file list"><button className="training-button secondary" type="button" disabled={busy || draft.status === "published"} onClick={() => { void guard.requestLeave(() => {
        setNewFile(true); setSelected(null); setFilePath(""); setContent({ encoding: "utf8", data: "" }); setDeleteConfirm(false); setError(null);
      }); }}>New file</button>
        {files.map(file => <button key={file.path} className={file.path === selected?.path ? "active" : ""} type="button" disabled={busy || file.sizeBytes > 6_000_000} title={`${file.path} · ${file.sizeBytes.toLocaleString()} bytes${file.sizeBytes > 6_000_000 ? " · exceeds the 6 MB editor limit" : ""}`} onClick={() => { void guard.requestLeave(() => { void open(file.path); }); }}>{file.path}{!file.writable ? " · read only" : ""}</button>)}
      </aside>
      <section aria-label="File editor">
        {selected || newFile ? <>
          <div className="taskset-draft-file-actions">
            {newFile ? <label>File path<input value={filePath} disabled={busy} onChange={event => setFilePath(event.target.value)} placeholder="graders/verify.js" /></label> : <strong>{filePath}</strong>}
            <button className="training-button" type="button" disabled={busy || !writable || !filePath || !dirty} onClick={() => { void save(false); }}>Save file</button>
            {selected?.writable && draft.status !== "published" ? <button className="training-text-button" type="button" disabled={busy} onClick={() => setDeleteConfirm(true)}>Delete file</button> : null}
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
