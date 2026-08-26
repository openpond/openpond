import type {
  ManagedAdapterServingProjection,
  TrainingStateResponse,
} from "@openpond/contracts";

import { Loader2 } from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

type LabServingRow = {
  lineageId: string;
  modelProjectId: string;
  modelName: string;
  versionLabel: string;
  managed: ManagedAdapterServingProjection;
  updatedAt: string;
};

export function LabServingPage({
  modelProjectId = null,
  state,
}: {
  modelProjectId?: string | null;
  state: TrainingStateResponse | null;
}) {
  if (!state) {
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading serving state…
      </div>
    );
  }

  const rows = labServingRows(state, modelProjectId);
  return (
    <div className="labs-flat-body labs-serving-page">
      <ModelProjectPageHeader
        title="Serving"
        description="Published adapters, active bindings, and deployment readiness."
        metrics={[
          { label: "Bindings", value: rows.length },
          { label: "Ready", value: rows.filter((row) => row.managed.customerBindingAllowed).length },
          { label: "Pending", value: rows.filter((row) => !row.managed.customerBindingAllowed).length },
        ]}
      />
      <section className="labs-operational-section" aria-labelledby="managed-serving-title">
        <header>
          <div>
            <h2 id="managed-serving-title">Managed serving</h2>
            <p>
              Durable adapter publication and binding state synchronized from
              OpenPond Managed training.
            </p>
          </div>
        </header>
        {!rows.length ? (
          <div className="labs-table-empty">No managed serving bindings are synchronized.</div>
        ) : (
          <div className="training-table-wrap">
            <table className="training-data-table labs-managed-serving-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Synchronization</th>
                  <th>Artifact</th>
                  <th>Deployment</th>
                  <th>Admission</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.lineageId}>
                    <td>
                      <span className="labs-serving-model">
                        <strong>{row.modelName}</strong>
                        <span>{row.versionLabel}</span>
                      </span>
                    </td>
                    <td>
                      <LabStatusBadge
                        label={managedStateLabel(row.managed.state)}
                        value={row.managed.state}
                      />
                    </td>
                    <td>{managedStateLabel(row.managed.canonicalArtifactState)}</td>
                    <td>{managedStateLabel(row.managed.canonicalDeploymentState)}</td>
                    <td>{row.managed.customerBindingAllowed ? "Allowed" : "Pending"}</td>
                    <td>{formatDateTime(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function labServingRows(
  state: TrainingStateResponse,
  modelProjectId: string | null = null,
): LabServingRow[] {
  const projectById = new Map(
    state.modelProjects.map((project) => [project.id, project] as const),
  );
  const versionByLineageId = new Map(
    state.modelVersions.flatMap((version) =>
      version.artifactLineageId
        ? [[version.artifactLineageId, version] as const]
        : [],
    ),
  );

  return state.models
    .flatMap((lineage) => {
      if (!lineage.managedServing) return [];
      const version = versionByLineageId.get(lineage.id) ?? null;
      const project = projectById.get(lineage.modelId) ?? null;
      return [{
        lineageId: lineage.id,
        modelProjectId: lineage.modelId,
        modelName: project?.name ?? lineage.modelId,
        versionLabel: version ? `Version ${version.version}` : lineage.id,
        managed: lineage.managedServing,
        updatedAt: lineage.managedServing.lastSyncedAt,
      }];
    })
    .filter((row) => !modelProjectId || row.modelProjectId === modelProjectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function managedStateLabel(value: string | null): string {
  return value
    ? value
        .replaceAll("_", " ")
        .replace(/^./, (character) => character.toUpperCase())
    : "Pending";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
