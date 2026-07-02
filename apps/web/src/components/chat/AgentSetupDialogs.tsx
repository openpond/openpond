import { useState, type ReactNode } from "react";
import { OPENPOND_MANIFEST_FILE_NAME } from "@openpond/contracts";
import type { SandboxProjectSourceType } from "../../lib/sandbox-types";
import { starterManifestPreview } from "./workspace-environment-helpers";

export type ProjectAgentDialogKind = "config" | "connect" | "sync" | "agent" | "run";

export type AgentConfigDialogInput = {
  name: string;
  preset: string;
  manifestPath: string;
};

export type ConnectProjectDialogInput = {
  teamId: string;
  projectName: string;
  sourceType: SandboxProjectSourceType;
  sourceIdentity: string;
  defaultBranch: string;
  syncNow: boolean;
};

export type CreateAgentDialogInput = {
  agentName: string;
  createTestRun: boolean;
};

export function AgentConfigDialog({
  busy,
  error,
  projectName,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  projectName: string;
  onClose: () => void;
  onSubmit: (input: AgentConfigDialogInput) => void;
}) {
  const [preset, setPreset] = useState("action");
  const [manifestPath, setManifestPath] = useState(OPENPOND_MANIFEST_FILE_NAME);
  const name = projectName.trim() || "local-agent";
  return (
    <AgentSetupDialogFrame title="Add Agent config" busy={busy} error={error} onClose={onClose}>
      <label>
        <span>Template preset</span>
        <select value={preset} onChange={(event) => setPreset(event.target.value)} disabled={busy}>
          <option value="action">Action</option>
          <option value="cron">Cron</option>
          <option value="background">Background worker</option>
          <option value="resources">Resource profile</option>
        </select>
      </label>
      <label>
        <span>Manifest path</span>
        <input value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} disabled={busy} />
      </label>
      <pre>{starterManifestPreview(name, preset)}</pre>
      <AgentSetupDialogActions
        busy={busy}
        actionLabel="Write config"
        canSubmit={Boolean(manifestPath.trim())}
        onClose={onClose}
        onSubmit={() => onSubmit({ name, preset, manifestPath: manifestPath.trim() })}
      />
    </AgentSetupDialogFrame>
  );
}

export function ConnectProjectDialog({
  busy,
  defaultBranch,
  defaultTeamId,
  error,
  projectName,
  sourceIdentity,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  defaultBranch: string;
  defaultTeamId: string;
  error: string | null;
  projectName: string;
  sourceIdentity: string;
  onClose: () => void;
  onSubmit: (input: ConnectProjectDialogInput) => void;
}) {
  const teamId = defaultTeamId;
  const [name, setName] = useState(projectName);
  const [sourceType, setSourceType] = useState<SandboxProjectSourceType>(
    /github\.com[:/]/i.test(sourceIdentity) ? "github_repo" : "manual",
  );
  const [sourceValue, setSourceValue] = useState(sourceIdentity);
  const [branch, setBranch] = useState(defaultBranch || "main");
  const [syncNow, setSyncNow] = useState(true);

  return (
    <AgentSetupDialogFrame title="Connect Project" busy={busy} error={error} onClose={onClose}>
      <label>
        <span>Project name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      </label>
      <div className="agent-setup-two-col">
        <label>
          <span>Source type</span>
          <select value={sourceType} onChange={(event) => setSourceType(event.target.value as SandboxProjectSourceType)} disabled={busy}>
            <option value="manual">Manual</option>
            <option value="github_repo">GitHub repo</option>
            <option value="internal_repo">Internal repo</option>
            <option value="template">Template</option>
          </select>
        </label>
        <label>
          <span>Default branch</span>
          <input value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy} />
        </label>
      </div>
      <label>
        <span>Source identity</span>
        <input value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} disabled={busy} />
      </label>
      <label className="agent-setup-check">
        <input type="checkbox" checked={syncNow} onChange={(event) => setSyncNow(event.target.checked)} disabled={busy} />
        <span>Sync now</span>
      </label>
      <AgentSetupDialogActions
        busy={busy}
        actionLabel={syncNow ? "Connect and sync" : "Connect Project"}
        canSubmit={Boolean(name.trim() && teamId)}
        onClose={onClose}
        onSubmit={() =>
          onSubmit({
            teamId,
            projectName: name.trim(),
            sourceType,
            sourceIdentity: sourceValue.trim(),
            defaultBranch: branch.trim(),
            syncNow,
          })
        }
      />
    </AgentSetupDialogFrame>
  );
}

export function CreateAgentDialog({
  busy,
  defaultName,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  defaultName: string;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CreateAgentDialogInput) => void;
}) {
  const [agentName, setAgentName] = useState(defaultName);
  const [createTestRun, setCreateTestRun] = useState(true);
  return (
    <AgentSetupDialogFrame title="Create Agent" busy={busy} error={error} onClose={onClose}>
      <label>
        <span>Agent name</span>
        <input value={agentName} onChange={(event) => setAgentName(event.target.value)} disabled={busy} />
      </label>
      <div className="agent-setup-summary">Entire manifest · Manual trigger · Package defaults</div>
      <label className="agent-setup-check">
        <input type="checkbox" checked={createTestRun} onChange={(event) => setCreateTestRun(event.target.checked)} disabled={busy} />
        <span>Create and test run</span>
      </label>
      <AgentSetupDialogActions
        busy={busy}
        actionLabel="Create Agent"
        canSubmit={Boolean(agentName.trim())}
        onClose={onClose}
        onSubmit={() => onSubmit({ agentName: agentName.trim(), createTestRun })}
      />
    </AgentSetupDialogFrame>
  );
}

export function ConfirmAgentSetupDialog({
  actionLabel,
  busy,
  error,
  summary,
  title,
  onClose,
  onSubmit,
}: {
  actionLabel: string;
  busy: boolean;
  error: string | null;
  summary: string;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <AgentSetupDialogFrame title={title} busy={busy} error={error} onClose={onClose}>
      <div className="agent-setup-summary">{summary}</div>
      <AgentSetupDialogActions
        busy={busy}
        actionLabel={actionLabel}
        canSubmit
        onClose={onClose}
        onSubmit={onSubmit}
      />
    </AgentSetupDialogFrame>
  );
}

function AgentSetupDialogFrame({
  busy,
  children,
  error,
  title,
  onClose,
}: {
  busy: boolean;
  children: ReactNode;
  error: string | null;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="agent-setup-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="agent-setup-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </header>
        {error ? <div className="agent-setup-error">{error}</div> : null}
        <div className="agent-setup-fields">{children}</div>
      </section>
    </div>
  );
}

function AgentSetupDialogActions({
  actionLabel,
  busy,
  canSubmit,
  onClose,
  onSubmit,
}: {
  actionLabel: string;
  busy: boolean;
  canSubmit: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="agent-setup-dialog-actions">
      <button type="button" disabled={busy} onClick={onClose}>
        Cancel
      </button>
      <button type="button" disabled={busy || !canSubmit} onClick={onSubmit}>
        {busy ? "Working" : actionLabel}
      </button>
    </div>
  );
}
