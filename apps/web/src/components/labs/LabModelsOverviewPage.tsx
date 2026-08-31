import type { ModelRun, TrainingStateResponse } from "@openpond/contracts";

import { formatDateTime, statusLabel } from "../training/training-model-data";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { labServingRows } from "./LabServingPage";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

const ACTIVE_RUN_STATUSES = new Set(["prepared", "running"]);

export function LabModelsOverviewPage({
  items,
  state,
  onOpenProject,
  onOpenRun,
  onOpenServing,
}: {
  items: LabWorkproductSummary[];
  state: TrainingStateResponse | null;
  onOpenProject: (projectId: string) => void;
  onOpenRun: (run: ModelRun) => void;
  onOpenServing: (projectId: string) => void;
}) {
  const projects = new Map(
    (state?.modelProjects ?? []).map((project) => [project.id, project] as const),
  );
  const runs = [...(state?.modelRuns ?? [])].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const activeRuns = runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const servingRows = state ? labServingRows(state) : [];
  const readyServingRows = servingRows.filter(
    (row) => row.managed.customerBindingAllowed,
  );

  return (
    <div className="labs-flat-body labs-resource-page labs-models-overview-page">
      <ModelProjectPageHeader
        title="Models overview"
        description="See what is running, what is serving, and where recent model work needs attention."
        metrics={[
          { label: "Active runs", value: activeRuns.length, hint: activeRuns.length ? "Running or prepared" : "No work in progress" },
          { label: "Ready to serve", value: readyServingRows.length, hint: `${servingRows.length} synchronized binding${servingRows.length === 1 ? "" : "s"}` },
          { label: "Model Projects", value: items.length, hint: `${runs.length} total run${runs.length === 1 ? "" : "s"}` },
          { label: "Latest activity", value: runs[0] ? formatDateTime(runs[0].updatedAt) : "None", hint: runs[0] ? projectName(runs[0].modelId, projects) : "Create a project to begin" },
        ]}
      />

      <div className="labs-models-operational-grid">
        <OperationalSection
          title="Running now"
          description="Prepared and active training or evaluation runs."
          empty="No runs are active right now."
        >
          {activeRuns.map((run) => (
            <button
              className="labs-operational-row"
              key={run.id}
              type="button"
              onClick={() => onOpenRun(run)}
            >
              <span>
                <strong>{projectName(run.modelId, projects)}</strong>
                <small>{runKindLabel(run)} · {run.taskset.id}</small>
              </span>
              <LabStatusBadge label={statusLabel(run.status)} value={run.status} pulse={run.status === "running"} />
            </button>
          ))}
        </OperationalSection>

        <OperationalSection
          title="Serving now"
          description="Synchronized adapter bindings and their admission state."
          empty="No managed serving bindings are synchronized."
        >
          {servingRows.slice(0, 6).map((row) => (
            <button
              className="labs-operational-row"
              key={row.lineageId}
              type="button"
              onClick={() => onOpenServing(row.modelProjectId)}
            >
              <span>
                <strong>{row.modelName}</strong>
                <small>{row.versionLabel} · {formatDateTime(row.updatedAt)}</small>
              </span>
              <LabStatusBadge
                label={row.managed.customerBindingAllowed ? "Ready" : "Pending"}
                value={row.managed.customerBindingAllowed ? "ready" : row.managed.state}
              />
            </button>
          ))}
        </OperationalSection>
      </div>

      <section className="training-detail-section">
        <div className="labs-project-trends-heading">
          <div>
            <h2>Recent activity</h2>
            <p>The latest immutable runs across Model Projects.</p>
          </div>
          <span>Latest 8</span>
        </div>
        <div className="training-table-wrap">
          <table className="training-data-table labs-models-activity-table">
            <thead>
              <tr><th>Model Project</th><th>Activity</th><th>Status</th><th>Taskset</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {runs.slice(0, 8).map((run) => (
                <tr key={run.id} onClick={() => onOpenRun(run)}>
                  <td>
                    <button className="labs-version-row-button" type="button" onClick={(event) => {
                      event.stopPropagation();
                      onOpenProject(run.modelId);
                    }}>
                      <strong>{projectName(run.modelId, projects)}</strong>
                      <small>{run.modelId}</small>
                    </button>
                  </td>
                  <td>{runKindLabel(run)}</td>
                  <td><LabStatusBadge label={statusLabel(run.status)} value={run.status} /></td>
                  <td>{run.taskset.id}</td>
                  <td>{formatDateTime(run.updatedAt)}</td>
                </tr>
              ))}
              {!runs.length ? (
                <tr><td colSpan={5}><div className="training-run-placeholder">No model activity has been recorded yet.</div></td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function OperationalSection({
  children,
  description,
  empty,
  title,
}: {
  children: React.ReactNode;
  description: string;
  empty: string;
  title: string;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="labs-operational-card">
      <header><div><h2>{title}</h2><p>{description}</p></div></header>
      <div className="labs-operational-card-body">
        {hasChildren ? children : <p className="labs-operational-empty">{empty}</p>}
      </div>
    </section>
  );
}

function projectName(
  projectId: string,
  projects: Map<string, TrainingStateResponse["modelProjects"][number]>,
): string {
  return projects.get(projectId)?.name ?? projectId;
}

function runKindLabel(run: ModelRun): string {
  if (run.kind === "evaluation") return "Evaluation";
  if (run.kind === "rollout_smoke") return "Preflight rollout";
  return run.method ? `${run.method.toUpperCase()} training` : "Training";
}
