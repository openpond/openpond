import { useEffect, useState, type FormEvent } from "react";

import { api, type ClientConnection, type ProfileWorkflowDiscovery } from "../../api";
import { CHAT_ATTACHMENT_LIMITS } from "@openpond/contracts";
import { composerAttachmentKind, createAttachmentId, readComposerAttachmentPayload } from "../chat/ComposerAttachments";
import { launchProfileWorkflow } from "./launch-profile-workflow";
import "../../styles/profile/profile-page.css";

export function ProfileWorkflowsSection({
  connection,
  selectedProfileKey,
  onError,
  onOpenSession,
  onToast,
  onEvaluate,
}: {
  connection: ClientConnection | null;
  selectedProfileKey: string | null;
  onError: (message: string | null) => void;
  onOpenSession?: (sessionId: string) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onEvaluate?: (workflowId: string) => void;
}) {
  const [catalog, setCatalog] = useState<ProfileWorkflowDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inputText, setInputText] = useState("{}");
  const [promptText, setPromptText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [workspaceTarget, setWorkspaceTarget] = useState<"local" | "hosted">("local");
  const [running, setRunning] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!connection || !selectedProfileKey) {
      setCatalog(null);
      return;
    }
    let active = true;
    setLoading(true);
    setCatalog(null);
    setSelectedId(null);
    setPromptText("");
    setFiles([]);
    setLocalError(null);
    void api.profileWorkflows(connection).then((result) => {
      if (active) setCatalog(result);
    }).catch((error: unknown) => {
      if (active) setLocalError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [connection, selectedProfileKey]);

  const selected = catalog?.workflows.find((entry) => entry.workflow.id === selectedId);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!connection || !catalog || !selected || running) return;
    let value: unknown;
    try {
      value = JSON.parse(inputText);
    } catch {
      setLocalError("Workflow input must be valid JSON.");
      return;
    }
    setRunning(true);
    setLocalError(null);
    onError(null);
    try {
      if (files.length > CHAT_ATTACHMENT_LIMITS.maxAttachments) {
        throw new Error(`Choose at most ${CHAT_ATTACHMENT_LIMITS.maxAttachments} files.`);
      }
      const attachments = await Promise.all(files.map(async (file) => {
        if (file.size > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes) {
          throw new Error(`${file.name} exceeds the attachment size limit.`);
        }
        return readComposerAttachmentPayload({
          id: createAttachmentId(),
          file,
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          kind: composerAttachmentKind(file),
        });
      }));
      const sessionId = await launchProfileWorkflow({
        connection,
        catalog,
        workflowId: selected.workflow.id,
        value,
        prompt: promptText,
        attachments,
        workspaceTarget,
      });
      onOpenSession?.(sessionId);
      onToast?.(`Started ${selected.workflow.label}`, "success");
      setSelectedId(null);
      setInputText("{}");
      setPromptText("");
      setFiles([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(message);
      onError(message);
    } finally {
      setRunning(false);
    }
  }

  if (!selectedProfileKey) return null;
  return (
    <section aria-label="Profile workflows" className="profile-workflows">
      <div className="profile-workflows-header">
        <h3>Workflows</h3>
        <p>Run a workflow from this Profile’s released source.</p>
      </div>
      {loading ? <p>Loading workflows…</p> : null}
      {localError ? <p role="alert">{localError}</p> : null}
      {catalog && catalog.workflows.length === 0 ? <p>No workflows in this Profile yet.</p> : null}
      {catalog?.workflows.map((entry) => (
        <div className="profile-workflows-row" key={entry.workflow.id}>
          <div>
            <strong>{entry.workflow.label}</strong>
            <p>{entry.workflow.description}</p>
            <small>Source {entry.binding.sourceRevision.slice(0, 10)} · release {entry.binding.harnessRelease.contentHash.slice(0, 10)}</small>
          </div>
          <button disabled={running} onClick={() => {
            setLocalError(null);
            setInputText("{}");
            setPromptText("");
            setFiles([]);
            setWorkspaceTarget(catalog.profileRef.source === "local" ? "local" : "hosted");
            setSelectedId(entry.workflow.id);
          }} type="button">Run</button>
          {onEvaluate ? <button disabled={running} onClick={() => onEvaluate(entry.workflow.id)} type="button">Evaluate</button> : null}
        </div>
      ))}
      {selected ? (
        <form className="profile-workflows-form" onSubmit={run}>
          <h4>Run {selected.workflow.label}</h4>
          <label htmlFor="profile-workflow-prompt">Instructions for this run</label>
          <textarea id="profile-workflow-prompt" onChange={(event) => setPromptText(event.target.value)} value={promptText} placeholder="Describe this run and provide any job-specific decisions." />
          <label htmlFor="profile-workflow-files">Files for this run</label>
          <input id="profile-workflow-files" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
          {files.length > 0 ? <p>{files.map((file) => file.name).join(", ")}</p> : null}
          <label htmlFor="profile-workflow-target">Run in</label>
          <select id="profile-workflow-target" value={workspaceTarget} onChange={(event) => setWorkspaceTarget(event.target.value as "local" | "hosted")}>
            <option value="local">Desktop local workspace</option>
            <option value="hosted">Hosted Work</option>
          </select>
          {selected.workflow.invocation.kind !== "instructions" ? <>
            <label htmlFor="profile-workflow-input">Input JSON</label>
            <textarea id="profile-workflow-input" onChange={(event) => setInputText(event.target.value)} value={inputText} />
            <pre>{JSON.stringify(selected.workflow.inputSchema, null, 2)}</pre>
          </> : null}
          <button disabled={running} type="submit">{running ? "Starting…" : "Start workflow"}</button>
          <button disabled={running} onClick={() => setSelectedId(null)} type="button">Cancel</button>
        </form>
      ) : null}
    </section>
  );
}
