import { useEffect, useState } from "react";
import { z } from "zod";
import { AgentImportPreviewSchema, AgentImportReceiptSchema, AgentImportCommitRequestSchema } from "openpond-sdk/connected-evidence";
import { WorkspacePanel } from "../WorkspacePanel";
import type { WorkspaceApi } from "../workspace-api";
import { Button, Input } from "./controls";
import { connectedCommand } from "./client";
import { uploadAgentFiles } from "./import-upload";
import { agentImportGuides } from "./import-guides";
type Preview = z.infer<typeof AgentImportPreviewSchema>;
type Receipt = z.infer<typeof AgentImportReceiptSchema>;
type Commit = z.infer<typeof AgentImportCommitRequestSchema>;

export function AgentImportPanel({ api, ownerUserId, projectId, projects, onClose, onImported }: {
  api: WorkspaceApi; ownerUserId: string; projectId?: string; projects: { id: string; name: string }[]; onClose(): void; onImported(receipt: Receipt): void;
}) {
  const teamId = api.teamId;
  const [source, setSource] = useState<keyof typeof agentImportGuides>("codex"), [files, setFiles] = useState<File[]>([]);
  const [destination, setDestination] = useState(projectId ?? "new"), [name, setName] = useState("My agent runs"), [branchLeaf, setBranchLeaf] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [upload, setUpload] = useState<{ hash: string; parts: number } | null>(null);
  const [selection, setSelection] = useState<Map<string, Set<string>>>(() => new Map()), [request, setRequest] = useState<Commit | null>(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(""), [error, setError] = useState<string | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const journalKey = `connected-import:${teamId}:${ownerUserId}`, guide = agentImportGuides[source];
  useEffect(() => {
    const saved = sessionStorage.getItem(journalKey); if (!saved) return;
    let value: unknown; try { value = JSON.parse(saved); } catch { sessionStorage.removeItem(journalKey); return; }
    const parsed = AgentImportCommitRequestSchema.safeParse(value);
    if (!parsed.success) { sessionStorage.removeItem(journalKey); return; }
    setRequest(parsed.data);
    connectedCommand(api, "read_import", { operationId: parsed.data.operationId }, AgentImportReceiptSchema).then(setReceipt).catch(() => {});
  }, [journalKey, teamId]);
  function invalidatePreview() { setPreview(null); setUpload(null); setSelection(new Map()); setRequest(null); setReceipt(null); }
  async function previewFiles() {
    setBusy(true); setError(null); setReceipt(null);
    try {
      const retained = await uploadAgentFiles(api, files, (done, total) => setProgress(`Uploading ${done} of ${total} parts…`));
      const value = await connectedCommand(api, "preview", { upload: retained, source, ...(branchLeaf.trim() ? { branchLeafId: branchLeaf.trim() } : {}),
        destination: destination === "new" ? { kind: "new", name } : { kind: "existing", projectId: destination } }, AgentImportPreviewSchema);
      setUpload(retained); setPreview(value); setSelection(new Map(value.sessions.map(session => [session.sessionHash, new Set(session.boundaries.filter(boundary => boundary.projection === "turn").map(boundary => boundary.id))])));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to preview these files."); }
    finally { setBusy(false); setProgress(""); }
  }
  function toggle(sessionHash: string, boundaryId: string) { setSelection(previous => {
    const next = new Map(previous), ids = new Set(next.get(sessionHash) ?? []); if (ids.has(boundaryId)) ids.delete(boundaryId); else ids.add(boundaryId); next.set(sessionHash, ids); return next;
  }); }
  async function commitSelected(resume?: Commit) {
    if (!resume && (!preview || !upload)) return;
    setBusy(true); setError(null);
    try {
      const exact = resume ?? AgentImportCommitRequestSchema.parse({ upload, source, ...(branchLeaf.trim() ? { branchLeafId: branchLeaf.trim() } : {}),
        destination: preview!.destination, previewHash: preview!.previewHash, operationId: `import-${crypto.randomUUID()}`,
        selection: [...selection].filter(([, ids]) => ids.size).map(([sessionHash, ids]) => ({ sessionHash, boundaryIds: [...ids] })) });
      setRequest(exact); sessionStorage.setItem(journalKey, JSON.stringify(exact));
      const value = await connectedCommand(api, "commit", exact, AgentImportReceiptSchema); setReceipt(value);
      if (value.state === "completed") { sessionStorage.removeItem(journalKey); onImported(value); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Import interrupted. Resume the retained operation."); }
    finally { setBusy(false); }
  }
  const selectedCount = [...selection.values()].reduce((sum, ids) => sum + ids.size, 0);
  return <WorkspacePanel action="agent-import" label="Import agent runs" onRequestClose={() => { if (!busy) onClose(); }}><h2>Import agent runs</h2><p>Keep selected recorded evidence private in a personal Project. Preview and import start no evaluation or training.</p>
    <div className="space-y-5 py-3 text-sm">
      {request ? <section><p>Retained import: {receipt?.state ?? "ready to resume"}</p><Button variant="outline" disabled={busy || receipt?.state === "completed"} onClick={() => commitSelected(request)}>Resume import</Button></section> : null}
      <label className="block">Source<select value={source} disabled={busy} className="mt-2 block w-full rounded-md bg-muted p-2" onChange={event => { setSource(event.target.value as typeof source); invalidatePreview(); }}>
        {Object.entries(agentImportGuides).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
      <section><h3 className="font-medium">How to get your logs</h3><p className="mt-2 text-muted-foreground">{guide.instruction}</p><pre className="mt-2 whitespace-pre-wrap">{guide.command}</pre>
        <p className="mt-2">{guide.fileType}. <a href={guide.url} target="_blank" rel="noreferrer" className="underline">Source documentation</a></p></section>
      <label className="block">{source === "openclaw" ? "Bundle folder" : "Session files"}<input className="mt-2 block w-full" type="file" multiple disabled={busy}
        {...(source === "openclaw" ? { webkitdirectory: "", directory: "" } : { accept: ".json,.jsonl,.zst" })}
        onChange={event => { setFiles(Array.from(event.target.files ?? [])); invalidatePreview(); }} /></label>
      <p className="text-muted-foreground">{files.length} files selected. Limit: 100 files and 32 MiB; expanded evidence has a separate bounded limit.</p>
      <label className="block">Destination<select className="mt-2 block w-full rounded-md bg-muted p-2" disabled={busy} value={destination} onChange={event => { setDestination(event.target.value); invalidatePreview(); }}>
        <option value="new">New personal Project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {destination === "new" ? <Input aria-label="New Project name" value={name} disabled={busy} onChange={event => { setName(event.target.value); invalidatePreview(); }} /> : null}
      {source === "claude_code" ? <details><summary>Select a transcript branch</summary><Input className="mt-2" aria-label="Branch leaf UUID" placeholder="Leaf UUID, if the preview reports several branches" value={branchLeaf} onChange={event => { setBranchLeaf(event.target.value); invalidatePreview(); }} /></details> : null}
      <Button variant="outline" disabled={busy || !files.length || destination === "new" && !name.trim()} onClick={previewFiles}>Preview selected files</Button>
      {progress ? <p role="status">{progress}</p> : null}{error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {preview ? <section><h3 className="font-medium">Preview: {preview.sessions.length} sessions, {selectedCount} boundaries selected</h3>
        {preview.issues.length ? <ul className="mt-2 list-disc pl-5 text-destructive">{preview.issues.map(issue => <li key={`${issue.file}:${issue.message}`}>{issue.file}: {issue.message}</li>)}</ul> : null}
        <ul className="divide-y divide-border">{preview.sessions.map(session => <li key={session.sessionHash} className="py-3"><p>{session.sessionId}</p><p className="text-xs text-muted-foreground">{session.exporterVersion ?? "Exporter version unavailable"}; {session.eventCount} retained events</p>
          <ul className="mt-2 list-disc pl-5 text-muted-foreground">{session.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
          <details className="mt-2"><summary>Sample retained messages</summary>{session.sample.map((message, index) => <pre key={index} className="mt-2 whitespace-pre-wrap break-words text-xs">{message.role}: {message.text}</pre>)}</details>
          {session.boundaries.map((boundary, index) => <label key={boundary.id} className="mt-2 flex items-start gap-3"><input type="checkbox" checked={selection.get(session.sessionHash)?.has(boundary.id) ?? false} onChange={() => toggle(session.sessionHash, boundary.id)} />
            <span>{boundary.projection === "turn" ? `Turn ${index + 1}` : "Conversation"}: {boundary.answer ? "answer retained" : "answer unavailable"}; process {boundary.process}; {boundary.terminal}</span></label>)}
        </li>)}</ul>
        <p className="mt-3 text-muted-foreground">Imported datasets remain drafts until their selected graders and fixtures validate and a release is published.</p>
        <Button className="mt-3" disabled={busy || !!preview.issues.length || !selectedCount} onClick={() => commitSelected()}>Import {selectedCount} selected boundaries</Button>
      </section> : null}
      {receipt ? <p role="status">{receipt.state}: {receipt.outcomes.length} session outcomes retained.</p> : null}
    </div>
  </WorkspacePanel>;
}
