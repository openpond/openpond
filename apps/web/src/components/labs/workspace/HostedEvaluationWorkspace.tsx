import { WeightSpaceDetail } from "./WeightSpaceDetail";
import { ManagedAlphaEditDetail } from "./ManagedAlphaEditDetail";
import { ManagedNeuronTrainingDetail } from "./ManagedNeuronTrainingDetail";
import { ManagedDecisionDetail } from "./ManagedDecisionDetail";
import { ManagedEngramDetail } from "./ManagedEngramDetail";
import { ErrorToast } from "../../common/ErrorToast";
import { UnifiedExperimentsPage } from "./UnifiedExperimentsPage";
import { LocalGraderPage } from "./LocalGraderPage";
import { LocalSavedDatasetPage } from "./LocalSavedDatasetPage";
import {
  WorkspaceResourceName,
  WorkspacePanelControls,
  useWorkspaceActions,
  type EvaluationSidebarControl,
} from "./WorkspacePanel";
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch, type ClientConnection } from "../../../api/api-client";
import { connectionQueryScope } from "../../../lib/query-scope";
import { modelsLocation, type ModelsRoute } from "../models-route";
import { createWorkspaceApi, workspaceApiForLocation, type Inventory } from "./workspace-api";
import { HostedExperimentsPage } from "./HostedExperimentsPage";
import { LocalExperimentsPage } from "./LocalExperimentsPage";
import { ManagedModificationDetail } from "./ManagedModificationDetail";
import { ModificationRecordingDetail } from "./ModificationRecordingDetail";
import { LocalProfileDatasetPage } from "./LocalProfileDatasetPage";
import { HostedDatasetsPage } from "./HostedDatasetsPage";
import { HostedGradersPage } from "./HostedGradersPage";
import { ProjectScopePicker } from "./ProjectScopePicker";
import { ExperimentWorkspaceFrame } from "./ExperimentWorkspaceFrame";
import { EvaluationSetupProvider, useEvaluationSetup } from "./EvaluationSetupState";
import { ExperimentSetupPanel } from "./ExperimentSetupPanel";
import { StoredExperimentDraftEntry } from "./StoredExperimentDraftEntry";
import "../../../styles/labs/evaluation-workspace.css";

const deviceOwnerSchema = z.object({ teamId: z.string().nullable() });

function HostedEvaluationWorkspaceContent({
  connection,
  teamId,
  accountKey,
  apiBaseUrl,
  actorId,
  route,
  onNavigate,
  onLocalDatasets,
  onResourceName,
  onOpenWork,
  modelProjectId = null,
}: {
  connection: ClientConnection | null;
  teamId: string | null;
  accountKey: string;
  apiBaseUrl?: string | null;
  actorId?: string | null;
  route: ModelsRoute;
  onNavigate: (route: ModelsRoute) => void;
  onLocalDatasets: () => void;
  onResourceName: (name: string | null) => void;
  onOpenWork?: (id: string) => void;
  modelProjectId?: string | null;
  onSidebarControl?: (control: EvaluationSidebarControl | null) => void;
}) {
  const setup = useEvaluationSetup();
  useWorkspaceActions(
    setup.draft || setup.advancedTarget
      ? [{ id: "experiment", label: "Experiment", onSelect: () => {} }]
      : [],
  );
  const localResultId = route.page === "experiments" && route.collection === "default" &&
    !route.projectId && route.resourceId &&
    (route.executionLocation ?? (route.resourceId.startsWith("local-") ? "local" : "hosted")) === "local"
    ? route.resourceId : null;
  const deviceOwner = useQuery({
    queryKey: ["device-benchmark-owner", connectionQueryScope(connection), localResultId],
    enabled: Boolean(connection && localResultId),
    queryFn: async ({ signal }) => deviceOwnerSchema.parse(await apiFetch(connection!, "/v1/local-experiments", {
      method: "POST",
      body: JSON.stringify({ action: "deviceOwner", payload: { id: localResultId } }),
      signal,
    })),
  });
  const deviceTeamId = deviceOwner.data?.teamId;
  const deviceApi = useMemo(() => connection && deviceTeamId
    ? createWorkspaceApi(connection, { teamId: deviceTeamId, accountKey: connectionQueryScope(connection),
        projectId: null, executionLocation: "local" })
    : null, [connection, deviceTeamId]);
  const resolvingDevice = Boolean(connection && localResultId && !deviceOwner.isSuccess);
  const api = useMemo(
    () =>
      connection && teamId
        ? createWorkspaceApi(connection, {
            teamId,
            accountKey,
            actorId,
            projectId: route.projectId ?? null,
            modelProjectId,
            executionLocation: route.resourceId
              ? (route.executionLocation ??
                (route.resourceId.startsWith("local-") ? "local" : "hosted"))
              : "local",
          })
        : null,
    [
      connection,
      teamId,
      accountKey,
      actorId,
      route.projectId,
      route.executionLocation,
      route.resourceId,
      modelProjectId,
    ],
  );
  const hostedApi = useMemo(() => (api ? workspaceApiForLocation(api, "hosted") : null), [api]);
  const setupApi = useMemo(
    () =>
      api
        ? createWorkspaceApi(api.connection, {
            teamId: api.teamId,
            accountKey: api.accountKey,
            actorId: api.actorId,
            modelProjectId: api.modelProjectId,
            projectId:
              setup.reviewRoute?.projectId === undefined
                ? api.projectId
                : setup.reviewRoute.projectId,
            executionLocation: setup.reviewRoute?.executionLocation ?? api.location,
          })
        : null,
    [api, setup.reviewRoute?.executionLocation, setup.reviewRoute?.projectId],
  );
  useEffect(() => {
    if (route.resourceId || route.projectId !== undefined) return;
    const scope = `${accountKey}:${teamId}`;
    const remembered = localStorage.getItem(`openpond:evaluation-project:${scope}`);
    if (remembered)
      onNavigate({ ...route, projectId: remembered, resourceId: null, detailTab: null });
  }, [accountKey, teamId, route, onNavigate]);
  const projects = useQuery({
    queryKey: ["evaluation-workspace", hostedApi?.key, "projects"],
    enabled: Boolean(hostedApi && !deviceApi && !resolvingDevice),
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) => hostedApi!.request<Inventory["projects"]>("projects", {}, signal),
  });
  const datasetCollection = route.page === "datasets" && !route.resourceId;
  const catalogCursor = datasetCollection && route.after?.startsWith("catalog:") ? route.after.slice(8) : undefined;
  const authoredCursor = datasetCollection && !catalogCursor ? route.after?.replace(/^workspace:/, "") : undefined;
  const datasetSort = datasetCollection ? route.sort ?? "name" : "name";
  const datasetSearch = datasetCollection ? route.query : "";
  const datasets = useQuery({
    queryKey: ["evaluation-workspace", hostedApi?.key, "datasets", authoredCursor, datasetSearch, datasetSort],
    enabled: Boolean(hostedApi && datasetCollection),
    retry: false,
    queryFn: ({ signal }) => hostedApi!.request<Inventory["datasets"]>("datasets", {
      cursor: authoredCursor, search: datasetSearch || undefined, sort: datasetSort,
    }, signal),
  });
  const loadingSetup = Boolean(setup.draft || setup.advancedTarget);
  const catalogApi = datasetCollection ? hostedApi : setupApi;
  const releasedDatasets = useQuery({
    queryKey: ["evaluation-workspace", catalogApi?.key, "catalogDatasets", catalogCursor, datasetSearch, datasetSort],
    enabled: Boolean(catalogApi && (datasetCollection || loadingSetup)),
    retry: false,
    queryFn: ({ signal }) => catalogApi!.request<Inventory["releasedDatasets"]>("catalogDatasets", {
      limit: 100, afterId: catalogCursor, search: datasetSearch || undefined, sort: datasetSort,
    }, signal),
  });
  const inventory: Inventory | null = api ? {
    teamId: api.teamId,
    apiOrigin: apiBaseUrl && URL.canParse(apiBaseUrl) ? new URL(apiBaseUrl).origin : "",
    projects: projects.data ?? { projects: [], nextCursor: null },
    datasets: datasets.data ?? { teamId: api.teamId, datasets: [], nextCursor: null },
    releasedDatasets: releasedDatasets.data ?? { items: [], nextCursor: null },
    experiments: { items: [], nextCursor: null },
  } : null;
  function changeProject(projectId: string | null) {
    localStorage.setItem(`openpond:evaluation-project:${accountKey}:${teamId}`, projectId ?? "");
    onNavigate({
      ...route,
      modelId: null,
      projectId,
      resourceId: null,
      detailTab: null,
      revision: undefined,
      contentHash: undefined,
      executionId: null,
      passId: null,
      after: null,
    });
  }
  if (resolvingDevice) {
    return deviceOwner.error ? (
      <ErrorToast error={deviceOwner.error}>
        <button className="training-button secondary" onClick={() => void deviceOwner.refetch()}>Retry Benchmark</button>
      </ErrorToast>
    ) : <p role="status">Loading Benchmark…</p>;
  }
  if (deviceApi) {
    return (
      <WorkspaceResourceName.Provider value={onResourceName}>
        <ExperimentWorkspaceFrame>
          <LocalExperimentsPage key={`${deviceApi.key}:${route.resourceId}`} api={deviceApi}
            route={route} navigate={onNavigate} installationRead />
        </ExperimentWorkspaceFrame>
      </WorkspaceResourceName.Provider>
    );
  }
  if (!api)
    return (
      <div className="labs-table-empty" role="status">
        Connect an OpenPond account and choose a workspace to open datasets, graders and
        benchmarks.
      </div>
    );
  return (
    <WorkspaceResourceName.Provider value={onResourceName}>
      <ExperimentWorkspaceFrame>
        <div className="evaluation-workspace-scope evaluation-scope-bar">
          <ProjectScopePicker
            key={api.key}
            api={api}
            page={projects.data}
            selectedId={route.projectId ?? null}
            onChange={changeProject}
          />
        </div>
        {projects.error && route.projectId ? (
          <ErrorToast error={projects.error} prefix="Projects">
            <button className="training-button secondary" onClick={() => void projects.refetch()}>
              Retry projects
            </button>
            {route.projectId ? (
              <button className="training-button secondary" onClick={() => changeProject(null)}>
                Return to All projects
              </button>
            ) : null}
          </ErrorToast>
        ) : null}
        {route.page === "graders" ? (
          route.resourceId && api.location === "local" ? (
            <LocalGraderPage api={api} route={route} navigate={onNavigate} />
          ) : (
            <HostedGradersPage
              key={`${api.key}:${route.resourceId ?? "collection"}`}
              api={hostedApi!}
              inventory={inventory}
              route={route}
              navigate={onNavigate}
            />
          )
        ) : route.page === "datasets" ? (
          route.resourceId && api.location === "local" ? (
            route.resourceId.startsWith("local-profile-") ? (
              <LocalProfileDatasetPage api={api} route={route} navigate={onNavigate} />
            ) : (
              <LocalSavedDatasetPage api={api} route={route} navigate={onNavigate} />
            )
          ) : (
            <HostedDatasetsPage
              key={`${hostedApi!.key}:${route.resourceId ?? "collection"}`}
              api={hostedApi!}
              inventory={inventory}
              inventoryLoading={datasetCollection && (datasets.isPending || releasedDatasets.isPending)}
              inventoryError={datasets.error?.message}
              route={{ ...route, executionLocation: "hosted" }}
              navigate={onNavigate}
              onLocalDatasets={onLocalDatasets}
              onRefresh={() => {
                if (!datasetCollection) return;
                void datasets.refetch();
                void releasedDatasets.refetch();
              }}
              releaseError={releasedDatasets.error?.message}
              onRetryReleases={() => void releasedDatasets.refetch()}
            />
          )
        ) : route.resourceId?.startsWith("managed-alphaedit:") ? (
          <ManagedAlphaEditDetail
            key={`${api.key}:${route.resourceId}`}
            api={workspaceApiForLocation(api, "hosted")}
            id={route.resourceId.slice("managed-alphaedit:".length)}
          />
        ) : route.resourceId?.startsWith("managed-weight-space:") ? (
          <WeightSpaceDetail key={`${api.key}:${route.resourceId}`} api={workspaceApiForLocation(api,"hosted")} id={route.resourceId.slice("managed-weight-space:".length)}/>
        ) : route.resourceId?.startsWith("managed-neuron-training:") ? (
          <ManagedNeuronTrainingDetail
            key={`${api.key}:${route.resourceId}`}
            api={workspaceApiForLocation(api, "hosted")}
            id={route.resourceId.slice("managed-neuron-training:".length)}
          />
        ) : route.resourceId?.startsWith("managed-decision:") ? (
          <ManagedDecisionDetail
            key={`${api.key}:${route.resourceId}`}
            api={workspaceApiForLocation(api, "hosted")}
            id={route.resourceId.slice("managed-decision:".length)}
          />
        ) : route.resourceId?.startsWith("managed-engram:") ? (
          <ManagedEngramDetail
            key={`${api.key}:${route.resourceId}`}
            api={workspaceApiForLocation(api, "hosted")}
            id={route.resourceId.slice("managed-engram:".length)}
          />
        ) : route.resourceId?.startsWith("managed-modification:") ? (
          <ManagedModificationDetail
            key={`${api.key}:${route.resourceId}`}
            api={workspaceApiForLocation(api, "hosted")}
            id={route.resourceId.slice("managed-modification:".length)}
            route={route}
          />
        ) : route.resourceId?.startsWith("modification-recording:") ? (
          <ModificationRecordingDetail
            key={`${api.key}:${route.resourceId}`}
            api={workspaceApiForLocation(api, "local")}
            id={route.resourceId.slice("modification-recording:".length)}
          />
        ) : !route.resourceId || route.collection === "drafts" ? (
          <>
            {route.collection === "drafts" && route.resourceId ? (
              <StoredExperimentDraftEntry
                key={`${api.key}:${route.resourceId}`}
                api={api}
                route={route}
              />
            ) : null}
            <UnifiedExperimentsPage api={api} route={route} navigate={onNavigate} />
          </>
        ) : api.location === "local" ? (
          <LocalExperimentsPage
            key={`${api.key}:${route.resourceId}`}
            api={api}
            route={route}
            navigate={onNavigate}
            onOpenWork={onOpenWork}
          />
        ) : (
          <HostedExperimentsPage
            key={`${api.key}:${route.resourceId}`}
            api={api}
            inventory={inventory}
            route={route}
            navigate={onNavigate}
            onOpenWork={onOpenWork}
            refresh={() => void projects.refetch()}
          />
        )}

        {setup.draft || setup.advancedTarget ? (
          <ExperimentSetupPanel
            key={setup.initialExperiment?.id ?? "advanced"}
            api={setupApi!}
            inventory={inventory}
            route={route}
            navigate={onNavigate}
            onClose={() => {
              if (route.collection === "drafts")
                onNavigate(
                  modelsLocation("experiments", null, {
                    area: route.area,
                    projectId: api.projectId,
                  }),
                );
            }}
            onAdvancedRun={(id) => {
              onNavigate(
                modelsLocation("runs", null, {
                  resourceId: `model-run:${id}`,
                  detailTab: "details",
                }),
              );
            }}
            onSaved={(value) => {
              onNavigate({
                ...route,
                page: "experiments",
                collection: "default",
                datasetKind: undefined,
                revision: undefined,
                contentHash: undefined,
                resourceId: value.id,
                executionLocation: setupApi!.location,
                detailTab: "overview",
                executionId: null,
                passId: null,
              });
            }}
          />
        ) : null}
      </ExperimentWorkspaceFrame>
    </WorkspaceResourceName.Provider>
  );
}

export function HostedEvaluationWorkspace(
  props: Parameters<typeof HostedEvaluationWorkspaceContent>[0],
) {
  return (
    <EvaluationSetupProvider
      key={JSON.stringify([
        props.accountKey,
        props.actorId ?? null,
        props.connection?.serverUrl ?? null,
        props.teamId,
        props.route.projectId ?? null,
      ])}
    >
      <WorkspacePanelControls onControl={props.onSidebarControl}>
        <HostedEvaluationWorkspaceContent {...props} />
      </WorkspacePanelControls>
    </EvaluationSetupProvider>
  );
}
