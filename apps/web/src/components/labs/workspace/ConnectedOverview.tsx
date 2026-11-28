import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClientConnection } from "../../../api";
import { apiFetch } from "../../../api/api-client";
import type { HostedModelProjectCatalog } from "../../../hooks/hosted-model-project-types";
import type { useTraining } from "../../../hooks/useTraining";
import { connectionQueryScope } from "../../../lib/query-scope";
import { EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";
import { createWorkspaceApi, type Inventory } from "./workspace-api";
import { ConnectedHome } from "./ConnectedHome";
import { UnifiedExperimentCollection } from "./UnifiedExperimentCollection";
import { modelsLocation, type ModelsRoute } from "../models-route";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import "../../../styles/labs/connected-overview.css";

function OverviewSection({
  title,
  onViewAll,
  children,
}: {
  title: string;
  onViewAll(): void;
  children: ReactNode;
}) {
  return (
    <section className="connected-overview-section" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button className="training-text-button" type="button" onClick={onViewAll}>
          View all
        </button>
      </header>
      {children}
    </section>
  );
}

/** The Console overview uses the same account-bound collections as their full pages. */
export function ConnectedOverview({
  connection,
  teamId,
  actorId,
  accountKey,
  apiOrigin,
  profileId,
  projectId,
  training,
  onNavigate,
  onCreateModel,
  onCreateDataset,
}: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  accountKey: string;
  apiOrigin: string;
  profileId: string;
  projectId: string | null;
  training: ReturnType<typeof useTraining>;
  onNavigate(route: ModelsRoute): void;
  onCreateModel(): void;
  onCreateDataset(): void;
}) {
  const api = useMemo(
    () => createWorkspaceApi(connection, { teamId, actorId, accountKey, projectId }),
    [connection, teamId, actorId, accountKey, projectId],
  );
  const [opening, setOpening] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const models = useQuery({
    queryKey: [
      "overview-models",
      connectionQueryScope(connection),
      accountKey,
      profileId,
      teamId,
      actorId,
    ],
    queryFn: async ({ signal }) => {
      const result = await apiFetch<HostedModelProjectCatalog>(
        connection,
        `/v1/training/hosted-model-projects?profileId=${encodeURIComponent(profileId)}&refresh=true`,
        { signal },
      );
      if (result.teamId !== teamId) throw new Error("The workspace changed. Refresh models.");
      return result;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  const inventory = useQuery({
    queryKey: ["overview-resources", connectionQueryScope(connection), api.key],
    queryFn: ({ signal }) => api.request<Inventory>("inventory", {}, signal),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  const modelRows = [...(models.data?.projects ?? [])].sort((a, b) =>
    b.project.updatedAt.localeCompare(a.project.updatedAt),
  );
  const authored = inventory.data?.datasets.datasets ?? [];
  const publishedIds = new Set(
    authored.flatMap((row) => (row.publication ? [row.publication.tasksetId] : [])),
  );
  const datasets = [
    ...authored.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      tasks: row.taskCount,
      updatedAt: row.updatedAt,
      release: false,
    })),
    ...(inventory.data?.releasedDatasets.items ?? [])
      .filter((row) => !publishedIds.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        status: "published",
        tasks: row.taskCount,
        updatedAt: row.createdAt,
        release: true,
      })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const route = (page: ModelsRoute["page"]) =>
    modelsLocation(page, null, page === "models" ? {} : { area: "console", projectId });
  async function openModel(id: string) {
    if (opening) return;
    setOpening(id);
    try {
      const result = await training.actions.openHostedModelProject(id, teamId, apiOrigin);
      if (result && live.current) onNavigate(modelsLocation("runs", result.project.id, { area: "console" }));
    } finally {
      setOpening(null);
    }
  }
  return (
    <main className="evaluation-workspace connected-overview">
      <div className="connected-overview-content">
        <ModelProjectPageHeader
          title="Overview"
          description="Models, benchmarks, datasets, and activity in your workspace."
          actions={
            <div className="model-build-actions">
              <button className="training-button secondary" type="button" onClick={onCreateDataset}>
                New dataset
              </button>
              <button className="training-button" type="button" onClick={onCreateModel}>
                New model
              </button>
            </div>
          }
        />
        <div className="connected-overview-grid">
          <OverviewSection title="Models" onViewAll={() => onNavigate(modelsLocation("models"))}>
            {projectId ? <p className="training-muted">All models in this workspace</p> : null}
            <div className="training-table-wrap">
              <table className="training-data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Starting model</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.slice(0, 6).map(({ project }) => (
                    <tr key={project.id}>
                      <td>
                        <button
                          className="labs-version-row-button"
                          type="button"
                          disabled={Boolean(opening)}
                          onClick={() => void openModel(project.id)}
                        >
                          {opening === project.id ? "Opening…" : project.name}
                        </button>
                      </td>
                      <td>
                        {project.trainingSetup.baseModel?.modelId ??
                          project.defaultBaseModel?.modelId ??
                          "—"}
                      </td>
                      <td>
                        <EvaluationTime value={project.updatedAt} />
                      </td>
                    </tr>
                  ))}
                  <EvaluationTableState
                    columns={3}
                    loading={models.isPending}
                    empty={!modelRows.length}
                    error={models.error?.message}
                    retry={() => void models.refetch()}
                  >
                    Create a model to start training.
                  </EvaluationTableState>
                </tbody>
              </table>
            </div>
          </OverviewSection>
          <OverviewSection title="Benchmarks" onViewAll={() => onNavigate(route("experiments"))}>
            <UnifiedExperimentCollection
              api={api}
              route={route("experiments")}
              navigate={onNavigate}
              previewLimit={6}
            />
          </OverviewSection>
        </div>
        <OverviewSection title="Datasets" onViewAll={() => onNavigate(route("datasets"))}>
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Tasks</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {datasets.slice(0, 6).map((row) => (
                  <tr key={`${row.release}:${row.id}`}>
                    <td>
                      <button
                        className="labs-version-row-button"
                        type="button"
                        onClick={() =>
                          onNavigate({
                            ...route("datasets"),
                            resourceId: row.id,
                            detailTab: "tasks",
                            ...(row.release ? { datasetKind: "release" as const } : {}),
                          })
                        }
                      >
                        {row.name}
                      </button>
                    </td>
                    <td>{row.tasks ?? "—"}</td>
                    <td>
                      <EvaluationStatus status={row.status} />
                    </td>
                    <td>
                      <EvaluationTime value={row.updatedAt} />
                    </td>
                  </tr>
                ))}
                <EvaluationTableState
                  columns={4}
                  loading={inventory.isPending}
                  empty={!datasets.length}
                  error={inventory.error?.message}
                  retry={() => void inventory.refetch()}
                >
                  Create or import a dataset.
                </EvaluationTableState>
              </tbody>
            </table>
          </div>
        </OverviewSection>
        <ConnectedHome
          connection={connection}
          teamId={teamId}
          actorId={actorId}
          accountKey={accountKey}
          projectId={projectId}
          embedded
          onProjectChange={(id) => onNavigate({ ...route("home"), projectId: id })}
          onOpenSources={(id) => onNavigate({ ...route("datasets"), projectId: id })}
        />
      </div>
    </main>
  );
}
