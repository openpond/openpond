import { useEffect, useMemo, useState } from "react";
import type { ClientConnection } from "../../api";
import {
  isLocalSidebarProjectItem,
  type SidebarProjectItem,
} from "../../lib/app-models";
import "../../styles/projects/projects-page.css";
import {
  Cloud,
  CloudUpload,
  ExternalLink,
  FolderGit2,
  Pin,
  PinOff,
  SquarePen,
} from "../icons";
import { ProjectDetailView } from "./ProjectDetailView";
import {
  cloudProjectRepositoryUrl,
  displayRepositoryUrl,
  openProjectUrl,
} from "./project-links";

type ProjectsPageProps = {
  accountBaseUrl: string | null;
  connection: ClientConnection | null;
  projects: SidebarProjectItem[];
  taskCountByProjectId: Record<string, number>;
  teamName: string | null;
  onNewCloudProject: () => void;
  onNewTask: (project: SidebarProjectItem) => void;
  onTogglePinned: (project: SidebarProjectItem) => void;
  onUploadLocalProject: (project: SidebarProjectItem) => void;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ProjectsPage({
  accountBaseUrl,
  connection,
  projects,
  taskCountByProjectId,
  teamName,
  onNewCloudProject,
  onNewTask,
  onTogglePinned,
  onUploadLocalProject,
}: ProjectsPageProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  useEffect(() => {
    if (selectedProjectId && !selectedProject) setSelectedProjectId(null);
  }, [selectedProject, selectedProjectId]);

  if (selectedProject) {
    return (
      <ProjectDetailView
        accountBaseUrl={accountBaseUrl}
        connection={connection}
        onBack={() => setSelectedProjectId(null)}
        onNewTask={onNewTask}
        onTogglePinned={onTogglePinned}
        onUploadLocalProject={onUploadLocalProject}
        project={selectedProject}
        taskCount={taskCountByProjectId[selectedProject.id] ?? 0}
        teamName={teamName}
      />
    );
  }

  return (
    <section aria-label="Projects" className="projects-page">
      <header className="projects-page-header">
        <div>
          <h1>Projects</h1>
          <p>
            Local projects on this device and hosted projects for {teamName ?? "your active team"}.
          </p>
        </div>
        <div className="projects-cloud-actions">
          <button className="projects-cloud-button" onClick={onNewCloudProject} type="button">
            <Cloud aria-hidden="true" size={15} />
            <span>New cloud project</span>
          </button>
        </div>
      </header>

      {projects.length === 0 ? (
        <div className="projects-empty">
          <FolderGit2 aria-hidden="true" size={24} />
          <h2>No projects yet</h2>
          <p>Create a hosted project for this team.</p>
        </div>
      ) : (
        <div className="projects-table-frame">
          <table className="projects-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Location</th>
                <th scope="col">Tasks</th>
                <th scope="col">Updated</th>
                <th aria-label="Project actions" scope="col" />
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const updatedAt = project.project.updatedAt;
                return (
                  <tr key={project.id}>
                    <td>
                      <button
                        className="projects-name-button"
                        onClick={() => setSelectedProjectId(project.id)}
                        type="button"
                      >
                        <span className={`projects-kind-icon ${projectScope(project)}`}>
                          {isLocalSidebarProjectItem(project) ? (
                            <FolderGit2 aria-hidden="true" size={16} />
                          ) : (
                            <Cloud aria-hidden="true" size={16} />
                          )}
                        </span>
                        <span className="projects-name-copy">
                          <strong>{project.project.name}</strong>
                        </span>
                      </button>
                    </td>
                    <td>
                      {isLocalSidebarProjectItem(project) ? (
                        <div className="projects-location-cell">
                          <span className="projects-location" title={project.project.path}>
                            {project.project.path}
                          </span>
                          <button
                            className="projects-upload-button"
                            onClick={() => onUploadLocalProject(project)}
                            title={`Upload ${project.project.name} to the active team`}
                            type="button"
                          >
                            <CloudUpload aria-hidden="true" size={13} />
                            <span>Upload</span>
                          </button>
                        </div>
                      ) : (
                        <ProjectLocationLink
                          accountBaseUrl={accountBaseUrl}
                          project={project}
                        />
                      )}
                    </td>
                    <td>{taskCountByProjectId[project.id] ?? 0}</td>
                    <td>
                      {updatedAt ? (
                        <time dateTime={updatedAt}>{formatDate(updatedAt)}</time>
                      ) : (
                        <span className="projects-table-muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="projects-row-actions">
                        <button
                          aria-label={`Start a new task in ${project.project.name}`}
                          onClick={() => onNewTask(project)}
                          title="New task"
                          type="button"
                        >
                          <SquarePen aria-hidden="true" size={15} />
                        </button>
                        <button
                          aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.project.name}`}
                          onClick={() => onTogglePinned(project)}
                          title={project.pinned ? "Unpin project" : "Pin project"}
                          type="button"
                        >
                          {project.pinned ? (
                            <PinOff aria-hidden="true" size={15} />
                          ) : (
                            <Pin aria-hidden="true" size={15} />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function projectScope(project: SidebarProjectItem): "desktop" | "cloud" | "linked" {
  if (!isLocalSidebarProjectItem(project)) return "cloud";
  return project.project.linkedSandboxProject && project.cloudLinkTrusted
    ? "linked"
    : "desktop";
}

function ProjectLocationLink({
  accountBaseUrl,
  project,
}: {
  accountBaseUrl: string | null;
  project: Extract<SidebarProjectItem, { kind: "cloud" }>;
}) {
  const href = cloudProjectRepositoryUrl(project, accountBaseUrl);
  if (!href) return <span className="projects-table-muted">Repository unavailable</span>;
  return (
    <a
      className="projects-location-link"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void openProjectUrl(href);
      }}
      title={href}
    >
      <span>{displayRepositoryUrl(href)}</span>
      <ExternalLink aria-hidden="true" size={12} />
    </a>
  );
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? dateFormatter.format(timestamp) : value;
}
