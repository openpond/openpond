import { parseAndVerifySavedModelVersionRead, type ExperimentDraft } from "openpond-sdk/training";
import { labModelVersions } from "./lab-models";
import { modelExperimentDraft } from "./model-experiment-draft";
import { ModelExperimentWorkspace } from "./workspace/ModelExperimentWorkspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorkspaceApi } from "./workspace/workspace-api";
import { apiFetch } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { CreateImproveRun, OpenPondProfileState } from "@openpond/contracts";
import type { LabsRouteProps } from "./labs-route-types";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { LabWorkproductDetail } from "./LabWorkproductDetail";
import { MODELS_PAGE_LABELS, modelsLocation, navigateModelsRoute, type ModelsRoute } from "./lab-primary-tab-state";

export function ModelsResourceDetail({ props, model, profile, runs, route, accountKey }: {
  accountKey: string;
  props: LabsRouteProps; model: LabWorkproductSummary; profile: OpenPondProfileState | null;
  runs: CreateImproveRun[]; route: ModelsRoute;
}) {
  const { training, profileView } = props;
  const teamId = training.settingsPreferences.defaultTeamId, actorId = props.account?.profile?.id, connection = profileView.connection;
  const servingApi = useMemo(() => connection && teamId && actorId ? createWorkspaceApi(connection, {
    teamId, actorId, projectId: route.projectId ?? null, accountKey,
  }) : undefined, [connection, teamId, actorId, route.projectId, accountKey]);
  const [experiment, setExperiment] = useState<ExperimentDraft | null>(null);
  const starting = useRef<string | null>(null);
  const scope = JSON.stringify([model.id, profileView.connection ? connectionQueryScope(profileView.connection) : null,
    training.settingsPreferences.defaultTeamId, props.account?.profile?.id]);
  const current = useRef(scope); current.current = scope;
  useEffect(() => { current.current = scope; return () => { current.current = "unmounted"; }; }, [scope]);
  async function newExperiment() {
    if (experiment || starting.current === scope) return;
    starting.current = scope;
    try {
      const state = training.training.payload;
      const project = state?.modelProjects.find(value => value.id === model.id);
      const teamId = training.settingsPreferences.defaultTeamId;
      if (!state || !project || !teamId || !props.account?.profile?.id || !profileView.connection)
        throw new Error("Load this Model in the current account and workspace before starting an experiment.");
      const versions = labModelVersions(model, runs, state);
      const selectedVersion = route.resourceId?.startsWith("version:")
        ? versions.find(value => value.lineage.id === route.resourceId!.slice(8))
        : versions.find(value => value.current) ?? versions[0] ?? null;
      if (route.resourceId?.startsWith("version:") && !selectedVersion)
        throw new Error("The selected Model version is unavailable. Sync the Model before retrying.");
      if (project.hosted && (project.hosted.apiOrigin !== props.account.apiBaseUrl || project.hosted.teamId !== teamId))
        throw new Error("Open this Model in its original hosted account and workspace.");
      const saved = project.hosted && !route.resourceId?.startsWith("version:")
        ? await parseAndVerifySavedModelVersionRead(await apiFetch(profileView.connection,
          `/v1/training/saved-models/${encodeURIComponent(project.hosted.projectId)}/version?teamId=${encodeURIComponent(teamId)}`),
          teamId, project.hosted.projectId) : null;
      if (current.current !== scope) return;
      const draft = await modelExperimentDraft({ project, version: selectedVersion ?? null, state, teamId, savedVersion: saved?.version });
      if (current.current === scope) setExperiment(draft);
    } catch (cause) { if (current.current === scope) training.onToast(cause instanceof Error ? cause.message : "The Model could not be opened for an experiment.", "error"); }
    finally { if (starting.current === scope) starting.current = null; }
  }
  const onLocationChange = useCallback((location: Parameters<LabsRouteProps["onDetailOpenChange"]>[0]) => {
    if (!location) { props.onDetailOpenChange(null); return; }
    const label = MODELS_PAGE_LABELS[route.page];
    props.onDetailOpenChange({ ...location, kindLabel: label,
      kindOnSelect: () => { void navigateModelsRoute(modelsLocation(route.page, route.modelId)); },
      workproductLabel: model.name,
      workproductOnSelect: () => { void navigateModelsRoute(modelsLocation("models", model.id)); },
      segments: location.segments?.filter((segment, index) => index !== 0 || segment.label !== label),
    });
  }, [props.onDetailOpenChange, route.page, route.modelId, model.id, model.name]);
  const closeDetail = useCallback(() => {
    void navigateModelsRoute(modelsLocation(route.page, route.modelId));
  }, [route.page, route.modelId]);
  const openDataset = (id: string) => { void navigateModelsRoute(modelsLocation("tasksets", route.modelId, { resourceId: id })); };
  const openEntry = (ref: string | null) => {
    const page = ref?.startsWith("version:") ? "versions" : route.page === "versions" ? "versions" : "runs";
    void navigateModelsRoute(modelsLocation(page, route.modelId, { resourceId: ref }));
  };
  const detail = <LabWorkproductDetail
    servingApi={servingApi}
    hostedWebBaseUrl={props.account?.baseUrl ?? null}
    hostedApiOrigin={props.account?.apiBaseUrl ?? null}
    connection={profileView.connection} profile={profile} runs={runs} training={training.training} workproduct={model}
    modelSection={route.page === "runs" ? "training" : route.page === "versions" ? "versions" : "overview"}
    modelDetailTab={route.detailTab} selectedModelEntryKey={route.resourceId}
    onModelDetailTabChange={(detailTab) => { void navigateModelsRoute({ ...route, detailTab }); }}
    onSelectedModelEntryKeyChange={openEntry}
    onAnswerQuestion={props.onAnswerQuestion} onApplyCandidate={props.onApplyCandidate} onApprove={props.onApprove} onCancel={props.onCancel}
    candidateReview={props.candidateReview} onCandidateReviewChange={props.onCandidateReviewChange}
    onChatWithModel={training.onChatWithModel} onOpenPullRequest={props.onOpenPullRequest} onOpenCandidateFiles={props.onOpenCandidateFiles}
    onOpenConversation={props.onOpenRunConversation}
    onOpenComparison={(id) => { void navigateModelsRoute(modelsLocation("runs", route.modelId, { collection: "series", resourceId: id })); }}
    onClose={closeDetail}
    onLocationChange={onLocationChange} onRenameAgent={() => undefined} onOpenDataset={openDataset}
    onPause={props.onPause} onReconcilePullRequest={props.onReconcilePullRequest} onRejectCandidate={props.onRejectCandidate} onResume={props.onResume} onRevise={props.onRevise}
    experimentOpen={Boolean(experiment)} onNewModelRun={newExperiment}
    onStartAgentChange={() => undefined} onToast={training.onToast}
    benchmarkDefaultModel={training.defaultModel} benchmarkProviderSettings={training.providerSettings}
  />;
  return experiment && profileView.connection && props.account?.profile?.id && training.settingsPreferences.defaultTeamId
    ? <ModelExperimentWorkspace key={experiment.id} draft={experiment} connection={profileView.connection}
      teamId={training.settingsPreferences.defaultTeamId} actorId={props.account.profile.id}
      accountKey={`${props.account.apiBaseUrl ?? ""}:${props.account.activeProfile?.handle ?? ""}`} route={route}
      onClose={() => setExperiment(null)} navigate={next => { void navigateModelsRoute(next); }}
      onSidebarControl={props.onEvaluationSidebarControl}>{detail}</ModelExperimentWorkspace>
    : detail;
}
