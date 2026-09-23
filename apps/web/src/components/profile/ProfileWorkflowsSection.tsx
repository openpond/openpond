import { useEffect, useState, type FormEvent } from "react";

import { api, type ClientConnection, type ProfileWorkflowDiscovery } from "../../api";
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
      const sessionId = await launchProfileWorkflow({
        connection,
        catalog,
        workflowId: selected.workflow.id,
        value,
      });
      onOpenSession?.(sessionId);
      onToast?.(`Started ${selected.workflow.label}`, "success");
      setSelectedId(null);
      setInputText("{}");
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
            setSelectedId(entry.workflow.id);
          }} type="button">Run</button>
          {onEvaluate ? <button disabled={running} onClick={() => onEvaluate(entry.workflow.id)} type="button">Evaluate</button> : null}
        </div>
      ))}
      {selected ? (
        <form className="profile-workflows-form" onSubmit={run}>
          <h4>Run {selected.workflow.label}</h4>
          <label htmlFor="profile-workflow-input">Input JSON</label>
          <textarea id="profile-workflow-input" onChange={(event) => setInputText(event.target.value)} value={inputText} />
          <pre>{JSON.stringify(selected.workflow.inputSchema, null, 2)}</pre>
          <button disabled={running} type="submit">{running ? "Starting…" : "Start workflow"}</button>
          <button disabled={running} onClick={() => setSelectedId(null)} type="button">Cancel</button>
        </form>
      ) : null}
    </section>
  );
}
