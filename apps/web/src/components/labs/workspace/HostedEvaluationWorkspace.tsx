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
import type { ClientConnection } from "../../../api/api-client";
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
function HostedEvaluationWorkspaceContent({
  connection,
  teamId,
  accountKey,
  actorId,
  route,
  onNavigate,
  onLocalDatasets,
  onResourceName,
  onOpenWork,
}: {
  connection: ClientConnection | null;
  teamId: string | null;
  accountKey: string;
  actorId?: string | null;
  route: ModelsRoute;
  onNavigate: (route: ModelsRoute) => void;
  onLocalDatasets: () => void;
  onResourceName: (name: string | null) => void;
  onOpenWork?: (id: string) => void;
  onSidebarControl?: (control: EvaluationSidebarControl | null) => void;
}) {
  const setup = useEvaluationSetup();
  useWorkspaceActions(
    setup.draft || setup.advancedTarget
      ? [{ id: "experiment", label: "Experiment", onSelect: () => {} }]
      : [],
  );
  const api = useMemo(
    () =>
      connection && teamId
        ? createWorkspaceApi(connection, {
            teamId,
            accountKey,
            actorId,
            projectId: route.projectId ?? null,
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
    if (route.projectId !== undefined) return;
    const scope = `${accountKey}:${teamId}`;
    const remembered = localStorage.getItem(`openpond:evaluation-project:${scope}`);
    if (remembered)
      onNavigate({ ...route, projectId: remembered, resourceId: null, detailTab: null });
  }, [accountKey, teamId, route, onNavigate]);
  const inventory = useQuery({
    queryKey: ["evaluation-workspace", api?.key, route.query, route.after, route.sort],
    enabled: Boolean(api),
    queryFn: ({ signal }) =>
      api!.request<Inventory>(
        "inventory",
        {
          ...(route.page === "datasets" ? { sort: route.sort ?? "name" } : {}),
          ...(route.query ? { search: route.query } : {}),
          ...(route.after
            ? route.page === "datasets"
              ? route.after.startsWith("catalog:")
                ? { catalogCursor: route.after.slice(8) }
                : {
                    cursor: route.after.startsWith("workspace:")
                      ? route.after.slice(10)
                      : route.after,
                  }
              : { afterId: route.after }
            : {}),
        },
        signal,
      ),
  });
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
  if (!api)
    return (
      <div className="labs-table-empty" role="status">
        Connect an OpenPond account and choose a workspace to open datasets, graders and
        experiments.
      </div>
    );
  return (
    <WorkspaceResourceName.Provider value={onResourceName}>
      <ExperimentWorkspaceFrame>
        <div className="evaluation-workspace-scope evaluation-scope-bar">
          <ProjectScopePicker
            key={api.key}
            api={api}
            page={inventory.data?.projects}
            selectedId={route.projectId ?? null}
            onChange={changeProject}
          />
        </div>
        {inventory.error ? (
          <ErrorToast error={inventory.error}>
            <button className="training-button secondary" onClick={() => void inventory.refetch()}>
              Retry workspace
            </button>
            {route.projectId ? (
              <button className="training-button secondary" onClick={() => changeProject(null)}>
                Return to All projects
              </button>
            ) : null}
          </ErrorToast>
        ) : null}
        {inventory.isPending ? <p role="status">Loading workspace…</p> : null}
        {route.page === "graders" ? (
          route.resourceId && api.location === "local" ? (
            <LocalGraderPage api={api} route={route} navigate={onNavigate} />
          ) : (
            <HostedGradersPage
              key={`${api.key}:${route.resourceId ?? "collection"}`}
              api={hostedApi!}
              inventory={inventory.data ?? null}
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
              inventory={inventory.data ?? null}
              inventoryLoading={inventory.isPending}
              inventoryError={inventory.error?.message}
              route={{ ...route, executionLocation: "hosted" }}
              navigate={onNavigate}
              onLocalDatasets={onLocalDatasets}
              onRefresh={() => void inventory.refetch()}
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
            inventory={inventory.data ?? null}
            inventoryLoading={inventory.isPending}
            inventoryError={inventory.error?.message}
            route={route}
            navigate={onNavigate}
            onOpenWork={onOpenWork}
            refresh={() => void inventory.refetch()}
          />
        )}

        {setup.draft || setup.advancedTarget ? (
          <ExperimentSetupPanel
            key={setup.initialExperiment?.id ?? "advanced"}
            api={setupApi!}
            inventory={inventory.data ?? null}
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
              void inventory.refetch();
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
