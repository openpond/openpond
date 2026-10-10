import { useState } from "react";
import type { ClientConnection } from "../../api/api-client";
import { DropdownSelect } from "../DropdownSelect";
import { usePonderDesktopAccess } from "./usePonderDesktopAccess";

export function PonderDesktopAccessSettings({ connection }: { connection: ClientConnection | null }) {
  const { access, busy, error, notice, refresh, change } = usePonderDesktopAccess(connection);
  const [projectId, setProjectId] = useState("");
  const project = access?.projects.find(item => item.id === projectId);
  const connected = Boolean(access?.authority);
  const options = [
    { value: "", label: "Choose a local project" },
    ...(access?.projects ?? []).map(item => ({
      value: item.id, label: item.name,
      description: item.shared ? "Shared with Ponder" : item.available ? item.cwd ?? undefined : "Folder unavailable",
    })),
  ];
  return <section className="remote-access-settings" aria-label="Ponder desktop access">
    <h2>Desktop access</h2>
    <p>Share a local project so Ponder can start tasks with the agents configured on this computer.</p>
    <div className="account-summary remote-access-summary">
      <div className="account-summary-main"><div>
        <strong>This computer</strong>
        <small role="status">{busy ? "Checking desktop access…" : connected ? "Connected to Ponder" : access?.desktop.ownerScope
          ? "Desktop connection unavailable" : error ? "Unable to load desktop access" : "Sign in and select a workspace"}</small>
      </div></div>
      <button type="button" className="settings-secondary" disabled={busy || !connection}
        onClick={() => void refresh()}>Refresh desktop access</button>
    </div>
    <div className="account-list">
      <div className="account-list-heading"><span>Local project</span><small>Current account and workspace</small></div>
      <div className="account-summary">
        <div className="account-summary-main"><div>
          <DropdownSelect value={project ? projectId : ""} options={options} label="Local project for Ponder"
            disabled={busy || !connected} searchable onChange={setProjectId} />
          {project?.cwd && <small>{project.cwd}</small>}
          {project && <small>{project.shared ? "Shared with Ponder" : project.previouslyShared
            ? "Share again for this connection" : "Not shared with Ponder"}</small>}
        </div></div>
        <button type="button" className="settings-secondary"
          disabled={busy || !project || !connected || (!project.shared && (!project.available || !project.revision))}
          onClick={() => project && void change(project, !project.shared)}>
          {project?.shared ? "Stop sharing" : "Share with Ponder"}
        </button>
      </div>
    </div>
    <p>Sharing lets Ponder request local work in this project and receive the requested results. Tasks use your existing agent permissions. Stop sharing here to remove it from discovery.</p>
    {connected && access?.projects.length === 0 && <p>No saved local projects are available. Add a project in the app, then refresh.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p>Desktop access could not be loaded. Refresh to try again.</p>}
  </section>;
}
