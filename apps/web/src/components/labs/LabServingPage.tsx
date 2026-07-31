import type {
  FireworksModelServingSession,
  ManagedAdapterServingProjection,
  TrainingStateResponse,
} from "@openpond/contracts";

import { Loader2 } from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";

type LabServingRow = {
  lineageId: string;
  modelName: string;
  versionLabel: string;
  session: FireworksModelServingSession | null;
  managed: ManagedAdapterServingProjection | null;
  updatedAt: string;
};

export function LabServingPage({
  busy,
  state,
  onStart,
  onStop,
}: {
  busy: boolean;
  state: TrainingStateResponse | null;
  onStart: (lineageId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  if (!state) {
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading serving state…
      </div>
    );
  }

  const rows = labServingRows(state);
  const managedRows = rows.filter((row) => row.managed);

  return (
    <div className="labs-flat-body labs-serving-page">
      <section className="labs-operational-section" aria-labelledby="temporary-serving-title">
        <header>
          <div>
            <h2 id="temporary-serving-title">Temporary serving</h2>
            <p>
              Bounded Fireworks sessions for testing trained model versions.
              Sessions stop on idle, duration, budget, or an explicit stop.
            </p>
          </div>
        </header>
        {!rows.length ? (
          <div className="labs-table-empty">
            No trained model versions are available for temporary serving.
          </div>
        ) : (
          <div className="training-table-wrap">
            <table className="training-data-table labs-serving-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Estimated cost</th>
                  <th>Updated</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const active =
                    row.session &&
                    ["starting", "ready", "stopping"].includes(row.session.state)
                      ? row.session
                      : null;
                  return (
                    <tr key={row.lineageId}>
                      <td>
                        <span className="labs-serving-model">
                          <strong>{row.modelName}</strong>
                          <span>{row.versionLabel}</span>
                        </span>
                      </td>
                      <td>
                        <LabStatusBadge
                          label={temporaryServingLabel(row.session)}
                          value={row.session?.state ?? "not_run"}
                        />
                      </td>
                      <td>{row.session?.provider ?? "Fireworks"}</td>
                      <td>
                        {row.session
                          ? `$${row.session.estimatedCostUsd.toFixed(4)}`
                          : "—"}
                      </td>
                      <td>{formatDateTime(row.updatedAt)}</td>
                      <td>
                        {active ? (
                          <button
                            className="training-button secondary labs-compact-button"
                            disabled={busy || active.state === "stopping"}
                            type="button"
                            onClick={() => onStop(active.id)}
                          >
                            {active.state === "stopping" ? "Stopping…" : "Stop serving"}
                          </button>
                        ) : (
                          <button
                            className="training-button secondary labs-compact-button"
                            disabled={busy}
                            type="button"
                            onClick={() => onStart(row.lineageId)}
                          >
                            Start serving
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="labs-operational-section" aria-labelledby="managed-serving-title">
        <header>
          <div>
            <h2 id="managed-serving-title">Managed serving</h2>
            <p>
              Durable adapter publication and binding state synchronized from
              the managed training path.
            </p>
          </div>
        </header>
        {!managedRows.length ? (
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
                {managedRows.map((row) => {
                  const managed = row.managed!;
                  return (
                    <tr key={row.lineageId}>
                      <td>
                        <span className="labs-serving-model">
                          <strong>{row.modelName}</strong>
                          <span>{row.versionLabel}</span>
                        </span>
                      </td>
                      <td>
                        <LabStatusBadge
                          label={managedStateLabel(managed.state)}
                          value={managed.state}
                        />
                      </td>
                      <td>{managedStateLabel(managed.canonicalArtifactState)}</td>
                      <td>{managedStateLabel(managed.canonicalDeploymentState)}</td>
                      <td>{managed.customerBindingAllowed ? "Allowed" : "Pending"}</td>
                      <td>{formatDateTime(managed.lastSyncedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function labServingRows(state: TrainingStateResponse): LabServingRow[] {
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
  const sessionsByLineageId = new Map<string, FireworksModelServingSession[]>();
  for (const session of state.servingSessions) {
    const sessions = sessionsByLineageId.get(session.modelArtifactLineageId) ?? [];
    sessions.push(session);
    sessionsByLineageId.set(session.modelArtifactLineageId, sessions);
  }

  return state.models
    .map((lineage) => {
      const version = versionByLineageId.get(lineage.id) ?? null;
      const sessions = sessionsByLineageId.get(lineage.id) ?? [];
      const session =
        sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ??
        null;
      const project = projectById.get(lineage.modelId) ?? null;
      return {
        lineageId: lineage.id,
        modelName: project?.name ?? lineage.modelId,
        versionLabel: version ? `Version ${version.version}` : lineage.id,
        session,
        managed: lineage.managedServing,
        updatedAt:
          session?.updatedAt ??
          lineage.managedServing?.lastSyncedAt ??
          lineage.importedAt,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function temporaryServingLabel(
  session: FireworksModelServingSession | null,
): string {
  if (!session) return "Not serving";
  if (session.state === "starting") return "Starting";
  if (session.state === "ready") return "Ready";
  if (session.state === "stopping") return "Stopping";
  if (session.state === "stopped") return "Stopped";
  return "Failed";
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
