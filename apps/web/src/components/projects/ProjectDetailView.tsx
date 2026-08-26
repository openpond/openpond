import type { OpenPondActionCatalogEntry } from "@openpond/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ClientConnection } from "../../api";
import type { SidebarProjectItem } from "../../lib/app-models";
import type { SandboxProject, SandboxProjectWorkspaceResponse } from "../../lib/sandbox-types";
import {
  ArrowLeft,
  CloudUpload,
  ExternalLink,
  Pin,
  PinOff,
  SquarePen,
} from "../icons";
import {
  displayRepositoryUrl,
  openProjectUrl,
  projectRepositoryUrl,
} from "./project-links";
import {
  ProjectDeploymentsTab,
  ProjectEnvironmentsTab,
  ProjectRequestsTab,
  ProjectWebsiteTab,
} from "./ProjectWorkspaceTabs";

type ProjectDetailTab = "source" | "actions" | "environments" | "deployments" | "requests" | "website";

type ProjectActionRow = {
  id: string;
  description: string | null;
  source: "hosted" | "local";
};

type ProjectDetailViewProps = {
  accountBaseUrl: string | null;
  connection: ClientConnection | null;
  project: SidebarProjectItem;
  taskCount: number;
  teamName: string | null;
  onBack: () => void;
  onNewTask: (project: SidebarProjectItem) => void;
  onTogglePinned: (project: SidebarProjectItem) => void;
  onUploadLocalProject: (project: SidebarProjectItem) => void;
};

export function ProjectDetailView({
  accountBaseUrl,
  connection,
  project,
  taskCount,
  teamName,
  onBack,
  onNewTask,
  onTogglePinned,
  onUploadLocalProject,
}: ProjectDetailViewProps) {
  const [tab, setTab] = useState<ProjectDetailTab>("source");
  const [hostedProject, setHostedProject] = useState<SandboxProject | null>(null);
  const [workspace, setWorkspace] = useState<SandboxProjectWorkspaceResponse | null>(null);
  const [workspaceUnavailable, setWorkspaceUnavailable] = useState(false);
  const [localActions, setLocalActions] = useState<ProjectActionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostedTarget = hostedProjectTarget(project);

  useEffect(() => {
    setTab("source");
  }, [project.id]);

  useEffect(() => {
    let active = true;
    setWorkspace(null);
    setHostedProject(null);
    setWorkspaceUnavailable(false);
    setLocalActions([]);
    setError(null);
    if (!connection) {
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    const hostedRequest = hostedTarget
      ? loadHostedProjectDetails(connection, hostedTarget)
      : Promise.resolve(null);
    const localRequest = project.kind === "local"
      ? api.localProjectActions(connection, project.project.id)
      : Promise.resolve(null);

    void Promise.allSettled([hostedRequest, localRequest]).then(([hostedResult, localResult]) => {
      if (!active) return;
      if (hostedResult.status === "fulfilled" && hostedResult.value) {
        setHostedProject(hostedResult.value.project);
        setWorkspace(hostedResult.value.workspace);
        setWorkspaceUnavailable(hostedResult.value.workspaceUnavailable);
      }
      if (localResult.status === "fulfilled" && localResult.value) {
        setLocalActions(localResult.value.actions.map(localActionRow));
      }
      const failures = [hostedResult, localResult].filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0 && failures.length === Number(Boolean(hostedTarget)) + Number(project.kind === "local")) {
        setError(failures[0]?.reason instanceof Error ? failures[0].reason.message : "Project details could not be loaded.");
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [connection, hostedTarget?.projectId, hostedTarget?.teamId, project]);

  const actions = useMemo(
    () => mergeProjectActions(hostedActionRows(hostedProject), localActions),
    [hostedProject, localActions],
  );
  const repositoryUrl = projectRepositoryUrl(project, accountBaseUrl);
  const sourceRows = projectSourceRows({
    hostedProject,
    project,
    repositoryUrl,
    taskCount,
    teamName,
  });

  return (
    <section aria-label={`${project.project.name} project`} className="project-detail-view">
      <header className="project-detail-header">
        <div className="project-detail-heading">
          <button className="project-detail-back" onClick={onBack} type="button">
            <ArrowLeft aria-hidden="true" size={15} />
            <span>Projects</span>
          </button>
          <h1>{project.project.name}</h1>
        </div>
        <div className="project-detail-actions">
          {project.kind === "local" ? (
            <button onClick={() => onUploadLocalProject(project)} type="button">
              <CloudUpload aria-hidden="true" size={14} />
              <span>Upload</span>
            </button>
          ) : null}
          {repositoryUrl ? (
            <button onClick={() => void openProjectUrl(repositoryUrl)} type="button">
              <ExternalLink aria-hidden="true" size={14} />
              <span>Open repository</span>
            </button>
          ) : null}
          <button onClick={() => onNewTask(project)} type="button">
            <SquarePen aria-hidden="true" size={14} />
            <span>New task</span>
          </button>
          <button
            aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.project.name}`}
            onClick={() => onTogglePinned(project)}
            title={project.pinned ? "Unpin project" : "Pin project"}
            type="button"
          >
            {project.pinned ? <PinOff aria-hidden="true" size={14} /> : <Pin aria-hidden="true" size={14} />}
          </button>
        </div>
      </header>

      <div aria-label="Project detail" className="project-detail-tabs" role="tablist">
        <button aria-selected={tab === "source"} onClick={() => setTab("source")} role="tab" type="button">
          Source
        </button>
        <button aria-selected={tab === "actions"} onClick={() => setTab("actions")} role="tab" type="button">
          Project Actions
          {actions.length > 0 ? <span>{actions.length}</span> : null}
        </button>
        <button aria-selected={tab === "environments"} onClick={() => setTab("environments")} role="tab" type="button">Environments</button>
        <button aria-selected={tab === "deployments"} onClick={() => setTab("deployments")} role="tab" type="button">Deployments</button>
        <button aria-selected={tab === "requests"} onClick={() => setTab("requests")} role="tab" type="button">Requests</button>
        <button aria-selected={tab === "website"} onClick={() => setTab("website")} role="tab" type="button">Website</button>
      </div>

      {error ? <div className="project-detail-error" role="alert">{error}</div> : null}
      {tab === "source" ? (
        <ProjectSourceTable loading={loading} rows={sourceRows} />
      ) : tab === "actions" ? (
        <ProjectActionsTable actions={actions} loading={loading} />
      ) : tab === "environments" ? (
        <ProjectEnvironmentsTab linked={Boolean(hostedTarget)} loading={loading} unavailable={workspaceUnavailable} workspace={workspace} />
      ) : tab === "deployments" ? (
        <ProjectDeploymentsTab linked={Boolean(hostedTarget)} loading={loading} unavailable={workspaceUnavailable} workspace={workspace} />
      ) : tab === "requests" ? (
        <ProjectRequestsTab linked={Boolean(hostedTarget)} loading={loading} unavailable={workspaceUnavailable} workspace={workspace} />
      ) : (
        <ProjectWebsiteTab linked={Boolean(hostedTarget)} loading={loading} unavailable={workspaceUnavailable} workspace={workspace} />
      )}
    </section>
  );
}

async function loadHostedProjectDetails(
  connection: ClientConnection,
  target: { projectId: string; teamId: string },
): Promise<{
  project: SandboxProject;
  workspace: SandboxProjectWorkspaceResponse | null;
  workspaceUnavailable: boolean;
}> {
  try {
    const workspace = await api.getSandboxProjectWorkspace(connection, target.projectId, {
      teamId: target.teamId,
    });
    return { project: workspace.project, workspace, workspaceUnavailable: false };
  } catch {
    const response = await api.getSandboxProject(connection, target.projectId, {
      teamId: target.teamId,
    });
    return { project: response.project, workspace: null, workspaceUnavailable: true };
  }
}

function ProjectSourceTable({ loading, rows }: { loading: boolean; rows: Array<[string, ReactNode]> }) {
  return (
    <div className="project-detail-table-frame">
      <table className="project-detail-table">
        <thead><tr><th>Setting</th><th>Value</th></tr></thead>
        <tbody>
          {rows.map(([label, value]) => <tr key={label}><td>{label}</td><td>{loading && label === "Latest commit" ? "Loading…" : value}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function ProjectActionsTable({ actions, loading }: { actions: ProjectActionRow[]; loading: boolean }) {
  if (loading) return <div className="project-detail-empty">Loading Project Actions…</div>;
  if (actions.length === 0) {
    return <div className="project-detail-empty">No Project Actions are registered from this source.</div>;
  }
  return (
    <div className="project-detail-table-frame">
      <table className="project-detail-table actions">
        <thead><tr><th>Action</th><th>Description</th><th>Source</th></tr></thead>
        <tbody>
          {actions.map((action) => (
            <tr key={`${action.source}:${action.id}`}>
              <td><code>{action.id}</code></td>
              <td>{action.description ?? "No description"}</td>
              <td>{action.source === "hosted" ? "Hosted project" : "Local source"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function projectSourceRows(input: {
  hostedProject: SandboxProject | null;
  project: SidebarProjectItem;
  repositoryUrl: string | null;
  taskCount: number;
  teamName: string | null;
}): Array<[string, ReactNode]> {
  const { hostedProject, project, repositoryUrl, taskCount, teamName } = input;
  const localLink = project.kind === "local" ? project.project.linkedSandboxProject : null;
  const branch = hostedProject?.gitBranch ?? hostedProject?.defaultBranch ??
    (project.kind === "cloud" ? project.project.defaultBranch : localLink?.defaultBranch) ?? "Not set";
  const commit = hostedProject ? projectSourceCommit(hostedProject) : localLink?.lastUploadedCommit ?? null;
  const syncedAt = hostedProject?.sandboxManifestSyncedAt ??
    (project.kind === "cloud" ? project.project.syncedAt : localLink?.syncedAt) ?? null;
  return [
    ["Repository", repositoryUrl ? <a href={repositoryUrl} onClick={(event) => { event.preventDefault(); void openProjectUrl(repositoryUrl); }}>{displayRepositoryUrl(repositoryUrl)}</a> : project.kind === "local" ? project.project.path : "Not available"],
    ["Branch", branch],
    ["Latest commit", commit ? shortCommit(commit) : "Not available"],
    ["Last synced", syncedAt ? formatDate(syncedAt) : "Not available"],
    ["Team", teamName ?? (project.kind === "cloud" ? project.project.organizationName : null) ?? "Local only"],
    ["Tasks", String(taskCount)],
  ];
}

function hostedProjectTarget(project: SidebarProjectItem): { projectId: string; teamId: string } | null {
  if (project.kind === "cloud") return { projectId: project.project.id, teamId: project.project.teamId };
  const linked = project.project.linkedSandboxProject;
  return linked ? { projectId: linked.projectId, teamId: linked.teamId } : null;
}

function hostedActionRows(project: SandboxProject | null): ProjectActionRow[] {
  const actions = project?.sandboxActionRegistry?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const id = typeof (row.id ?? row.name) === "string" ? String(row.id ?? row.name).trim() : "";
    if (!id) return [];
    return [{ id, description: typeof row.description === "string" ? row.description : null, source: "hosted" as const }];
  });
}

function localActionRow(action: OpenPondActionCatalogEntry): ProjectActionRow {
  return {
    id: action.id,
    description: action.description ?? action.label ?? action.name ?? null,
    source: "local",
  };
}

function mergeProjectActions(hosted: ProjectActionRow[], local: ProjectActionRow[]): ProjectActionRow[] {
  const rows = new Map<string, ProjectActionRow>();
  for (const action of [...hosted, ...local]) if (!rows.has(action.id)) rows.set(action.id, action);
  return Array.from(rows.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function projectSourceCommit(project: SandboxProject): string | null {
  const values = [
    project.sourceConfig.commitSha,
    project.sourceConfig.sourceCommitSha,
    project.metadata.commitSha,
    project.metadata.sourceCommitSha,
    project.templateRemoteSha,
  ];
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? null;
}

function shortCommit(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
