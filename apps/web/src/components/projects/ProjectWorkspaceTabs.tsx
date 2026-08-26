import { useState, type ReactNode } from "react";
import type {
  ProjectDeploymentSummary,
  ProjectRuntimeTrace,
  SandboxProjectWorkspaceResponse,
} from "../../lib/sandbox-types";
import { displayRepositoryUrl, openProjectUrl } from "./project-links";

type WorkspaceTabProps = {
  loading: boolean;
  workspace: SandboxProjectWorkspaceResponse | null;
  linked: boolean;
  unavailable: boolean;
};

export function ProjectEnvironmentsTab({ loading, workspace, linked, unavailable }: WorkspaceTabProps) {
  if (loading) return <ProjectTabMessage>Loading environments…</ProjectTabMessage>;
  if (!linked) return <ProjectTabMessage>Upload this local project to create cloud development environments.</ProjectTabMessage>;
  if (unavailable) return <ProjectTabMessage error>Unable to load environments.</ProjectTabMessage>;
  if (!workspace?.environments.length) {
    return <ProjectTabMessage>No development environment has been created for this project yet.</ProjectTabMessage>;
  }
  const preferredId = preferredEnvironmentId(workspace);
  return (
    <ProjectTable headings={["Environment", "Status", "Branch", "Default", "Updated"]}>
      {workspace.environments.map(({ sandbox, runtime }) => (
        <tr key={sandbox.id}>
          <td><strong>{environmentLabel(sandbox.metadata, sandbox.id)}</strong></td>
          <td><StatusText status={sandbox.state} /></td>
          <td><code>{runtime?.baseBranch ?? sandbox.repoRef ?? "Not available"}</code></td>
          <td>{sandbox.id === preferredId ? "Preferred" : "—"}</td>
          <td>{formatDate(sandbox.updatedAt)}</td>
        </tr>
      ))}
    </ProjectTable>
  );
}

export function ProjectDeploymentsTab({ loading, workspace, linked, unavailable }: WorkspaceTabProps) {
  if (loading) return <ProjectTabMessage>Loading deployments…</ProjectTabMessage>;
  if (!linked) return <ProjectTabMessage>Upload this local project before creating deployments.</ProjectTabMessage>;
  if (unavailable) return <ProjectTabMessage error>Unable to load deployments.</ProjectTabMessage>;
  if (workspace?.errors.deployments) return <ProjectTabMessage error>Unable to load deployments.</ProjectTabMessage>;
  if (!workspace?.website) return <ProjectTabMessage>Set up Website before creating a deployment.</ProjectTabMessage>;
  if (!workspace.deployments.length) return <ProjectTabMessage>No deployments yet.</ProjectTabMessage>;
  return (
    <ProjectTable headings={["Deployment", "Status", "Commit", "Build", "Created by", "Created"]}>
      {workspace.deployments.map((deployment) => <DeploymentRow deployment={deployment} key={deployment.release.id} />)}
    </ProjectTable>
  );
}

export function ProjectRequestsTab({ loading, workspace, linked, unavailable }: WorkspaceTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (loading) return <ProjectTabMessage>Loading requests…</ProjectTabMessage>;
  if (!linked) return <ProjectTabMessage>Upload this local project and set up Website to receive requests.</ProjectTabMessage>;
  if (unavailable) return <ProjectTabMessage error>Unable to load requests.</ProjectTabMessage>;
  if (workspace?.errors.requests) return <ProjectTabMessage error>Unable to load requests.</ProjectTabMessage>;
  if (!workspace?.website) return <ProjectTabMessage>Set up Website to receive requests.</ProjectTabMessage>;
  if (!workspace.requests.length) return <ProjectTabMessage>No requests yet.</ProjectTabMessage>;
  return (
    <div className="project-detail-table-frame">
      <table className="project-detail-table project-request-table">
        <thead><tr><th>Request</th><th>Status</th><th>Runtime</th><th>Started</th><th>Duration</th></tr></thead>
        {workspace.requests.map((trace) => {
          const expanded = selectedId === trace.id;
          return (
            <tbody key={trace.id}>
              <tr
                aria-expanded={expanded}
                className="project-request-row"
                onClick={() => setSelectedId((current) => current === trace.id ? null : trace.id)}
              >
                <td><code>{trace.method}</code> {publishedRequestPath(trace.path)}</td>
                <td><StatusText status={String(trace.responseStatus)} tone={trace.outcome === "failure" ? "error" : "success"} /></td>
                <td>{trace.coldStart === null ? "Unknown" : trace.coldStart ? "Cold" : "Warm"}</td>
                <td>{formatDate(trace.startedAt)}</td>
                <td>{formatMilliseconds(trace.totalDurationMs)}</td>
              </tr>
              {expanded ? <RequestStages trace={trace} /> : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

export function ProjectWebsiteTab({ loading, workspace, linked, unavailable }: WorkspaceTabProps) {
  if (loading) return <ProjectTabMessage>Loading website…</ProjectTabMessage>;
  if (!linked) return <ProjectTabMessage>Upload this local project before setting up Website.</ProjectTabMessage>;
  if (unavailable) return <ProjectTabMessage error>Unable to load the website.</ProjectTabMessage>;
  if (workspace?.errors.website) return <ProjectTabMessage error>Unable to load the website.</ProjectTabMessage>;
  const website = workspace?.website ?? null;
  const publicUrl = website?.settings.platformDomain ? `https://${website.settings.platformDomain}` : null;
  const sourceCommit = website?.releases.find((release) => release.id === website.settings.activeReleaseId)?.sourceCommitSha ?? null;
  const rows: Array<[string, ReactNode]> = [
    ["Public URL", publicUrl ? <a href={publicUrl} onClick={(event) => { event.preventDefault(); void openProjectUrl(publicUrl); }}>{displayRepositoryUrl(publicUrl)}</a> : "Not assigned"],
    ["Live release", website?.settings.activeReleaseId ? "Active" : "Not published"],
    ["Source", sourceCommit ? shortCommit(sourceCommit) : "Not available"],
    ["Account database", databaseSummary(workspace)],
    ["Availability", website?.settings.runtimePolicy?.availabilityMode === "always_on" ? "Always on" : "On demand"],
  ];
  return (
    <div className="project-detail-table-frame">
      <table className="project-detail-table">
        <thead><tr><th>Setting</th><th>Value</th></tr></thead>
        <tbody>{rows.map(([label, value]) => <tr key={label}><td>{label}</td><td>{value}</td></tr>)}</tbody>
      </table>
      {!website ? <div className="project-detail-table-note">Website has not been set up for this project.</div> : null}
    </div>
  );
}

function ProjectTable({ headings, children }: { headings: string[]; children: ReactNode }) {
  return <div className="project-detail-table-frame"><table className="project-detail-table"><thead><tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function ProjectTabMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`project-detail-empty${error ? " error" : ""}`}>{children}</div>;
}

function StatusText({ status, tone }: { status: string; tone?: "success" | "error" }) {
  return <span className={`project-detail-status${tone ? ` ${tone}` : ""}`}>{status.replaceAll("_", " ")}</span>;
}

function DeploymentRow({ deployment }: { deployment: ProjectDeploymentSummary }) {
  const { build, release } = deployment;
  return <tr><td><strong>v{release.version}</strong></td><td><StatusText status={release.status} tone={release.status === "failed" ? "error" : release.status === "active" || release.status === "ready" ? "success" : undefined} /></td><td><code>{release.sourceCommitSha ? shortCommit(release.sourceCommitSha) : "Not available"}</code></td><td>{build ? `${build.status.replaceAll("_", " ")} · ${build.currentStage.replaceAll("_", " ")}` : "Not started"}</td><td>{deployment.creatorName ?? "Unknown"}</td><td>{formatDate(release.createdAt)}</td></tr>;
}

function RequestStages({ trace }: { trace: ProjectRuntimeTrace }) {
  return <tr className="project-request-detail"><td colSpan={5}><dl>{trace.stages.map((stage, index) => <div key={`${stage.name}:${index}`}><dt>{stage.name.replaceAll("_", " ")}{stage.errorCode ? ` · ${stage.errorCode}` : ""}</dt><dd>{formatMilliseconds(stage.durationMs)}</dd></div>)}</dl>{trace.errorCode ? <p>{trace.errorCode}</p> : null}</td></tr>;
}

function preferredEnvironmentId(workspace: SandboxProjectWorkspaceResponse): string | null {
  const value = workspace.project.metadata.preferredDevelopmentSandboxId;
  return typeof value === "string" && value.trim() ? value : null;
}

function environmentLabel(metadata: Record<string, unknown>, fallback: string): string {
  for (const key of ["name", "label", "environmentName"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback.length > 18 ? fallback.slice(0, 18) : fallback;
}

function databaseSummary(workspace: SandboxProjectWorkspaceResponse | null): string {
  if (!workspace?.website) return "Set up the website first";
  if (workspace.errors.database) return "Unavailable";
  if (workspace.database?.status === "ready") return `Connected · ${workspace.database.provider}`;
  if (workspace.database?.status === "provisioning") return "Connecting…";
  return "Not connected";
}

function publishedRequestPath(value: string): string {
  const marker = "/ingress";
  const index = value.indexOf(marker);
  return index === -1 ? value : `/api${value.slice(index + marker.length) || "/"}`;
}

function shortCommit(value: string): string { return value.length > 12 ? value.slice(0, 12) : value; }
function formatMilliseconds(value: number): string { return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`; }
function formatDate(value: string): string { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString() : value; }
