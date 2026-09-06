import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LearnedPreferenceRewardBinding } from "@openpond/contracts";
import { api } from "../../api";
import { useCreateImproveRuns } from "../../hooks/useCreateImproveRuns";
import { useErrorToast } from "../../app/AppToastContext";
import { buildTrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { AppDialog } from "../dialogs/AppDialog";
import { DatasetSourcePickerDialog, type DatasetCreateSource } from "../datasets/DatasetSourcePickerDialog";
import { HuggingFaceDatasetImportDialog } from "../datasets/HuggingFaceDatasetImportDialog";
import { TasksetDraftEditor } from "../datasets/TasksetDraftEditor";
import { LabDatasetsPage, type TasksetDetailTab } from "./LabDatasetsPage";
import { LabEvaluationsPage, type EvaluationDetailTab } from "./LabEvaluationsPage";
import { LabHumanReviewsPage } from "./LabHumanReviewsPage";
import { LabScoringPage } from "./LabScoringPage";
import type { LabScorerCreateInput } from "./LabScorerCreateDialog";
import { LabModelCreateDialog, type LabModelCreateInput } from "./LabModelCreateDialog";
import { LabModelsPage } from "./LabModelsPage";
import { LabModelComparisonsPage } from "./LabModelComparisonsPage";
import { LabServingPage } from "./LabServingPage";
import { LabsView, type LabPrimaryTab } from "./LabsView";
import { ModelRunEditorPage } from "./ModelRunEditorPage";
import { ModelsResourceDetail } from "./ModelsResourceDetail";
import { ModelsAggregatePage } from "./ModelsAggregatePage";
import { LearningRewardsPage } from "./learning/LearningRewardsPage";
import { LearningTaskFormatsPage } from "./learning/LearningTaskFormatsPage";
import { LearningReviewPage } from "./learning/LearningReviewPage";
import { LearningBatchesPage } from "./learning/LearningBatchesPage";
import { useLearningClient } from "./learning/useLearningResources";
import { modelResourceOwner, modelScopedResources } from "./models-resource-scope";
import { labModelVersions } from "./lab-models";
import { labWorkproductProjection } from "./lab-workproducts";
import { newProject, nextModelName } from "./model-run-editor-helpers";
import { computeProfileAgentRunSyncKey, trainingModelRunSyncKey } from "./LabsRouteSections";
import { modelsLocation, modelsPath, modelsResourceLocation, MODELS_PAGE_LABELS, navigateModelsRoute, useModelsRoute, type ModelsRoute } from "./lab-primary-tab-state";
import type { LabsRouteProps } from "./labs-route-types";
export type { LabsRouteProps } from "./labs-route-types";

export function LabsRoute(props: LabsRouteProps) {
  const { profileView, training } = props;
  const profile = profileView.payload?.profile ?? null;
  const profileId = profile?.activeProfile ?? "default";
  const learningClient = useLearningClient(profileView.connection, profileId);
  const createImprove = useCreateImproveRuns({ connection: profileView.connection, profileId });
  const route = useModelsRoute();
  const state = training.training.payload;
  const [modelCreateOpen, setModelCreateOpen] = useState(false);
  const [importSource, setImportSource] = useState<"source" | DatasetCreateSource | null>(null);
  const [runTarget, setRunTarget] = useState<{ tasksetId?: string; reward?: LearnedPreferenceRewardBinding | null } | null>(null);
  const [selectedRunTarget, setSelectedRunTarget] = useState("");
  const workspaceKey = `${profileView.connection?.serverUrl ?? "disconnected"}:${profileId}:${training.settingsPreferences.defaultTeamId ?? "local"}:${props.account?.activeProfile?.handle ?? "local"}`;
  const priorWorkspace = useRef(workspaceKey);
  const workspaceChanged = priorWorkspace.current !== workspaceKey;
  useErrorToast(createImprove.error);
  useErrorToast(training.training.error);
  const workproducts = useMemo(() => labWorkproductProjection({ profile, training: state, runs: createImprove.runs }), [profile, state, createImprove.runs]);
  const models = useMemo(() => {
    const team = training.settingsPreferences.defaultTeamId?.trim() ?? null;
    const ids = new Set((state?.modelProjects ?? []).filter((project) => project.profileId === profileId && (project.hosted === null || project.hosted.teamId === team)).map((project) => project.id));
    return workproducts.filter((item) => item.kind === "model" && ids.has(item.id));
  }, [state, profileId, training.settingsPreferences.defaultTeamId, workproducts]);
  const selected = models.find((model) => model.id === route?.modelId) ?? null;
  const modelRunSyncKey = useMemo(() => trainingModelRunSyncKey(state), [state]);
  const agentRunSyncKey = useMemo(() => computeProfileAgentRunSyncKey(createImprove.runs), [createImprove.runs]);
  useEffect(() => {
    if (!profileView.connection) return;
    let active = true;
    void api.bootstrap(profileView.connection).then((payload) => { if (active) profileView.onPayload(payload); }).catch((error: unknown) => { if (active) profileView.onError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [profileView.connection, profileView.onPayload, profileView.onError, agentRunSyncKey]);
  useEffect(() => { if (modelRunSyncKey) void createImprove.refresh(); }, [modelRunSyncKey, createImprove.refresh]);
  useEffect(() => {
    if (!workspaceChanged) return;
    priorWorkspace.current = workspaceKey;
    setModelCreateOpen(false);
    setImportSource(null);
    setRunTarget(null);
    void navigateModelsRoute(modelsLocation(), "replace");
  }, [workspaceChanged, workspaceKey]);
  useEffect(() => {
    props.onSkillSelectionChange(null);
    return () => props.onDetailOpenChange(null);
  }, [props.onSkillSelectionChange, props.onDetailOpenChange]);
  const lastCloseRequest = useRef(props.closeDetailRequestId);
  useEffect(() => {
    if (lastCloseRequest.current === props.closeDetailRequestId) return;
    lastCloseRequest.current = props.closeDetailRequestId;
    if (route) void navigateModelsRoute(modelsLocation(route.page, route.modelId, { collection: ["new", "drafts"].includes(route.collection) ? "default" : route.collection }));
  }, [props.closeDetailRequestId, route]);
  useEffect(() => {
    if (!route) { props.onDetailOpenChange(null); return; }
    const label = MODELS_PAGE_LABELS[route.page];
    const kind = route.page === "tasksets" ? "dataset" : route.page === "rewards" ? "scoring" : route.page === "evaluations" ? "evaluation" : "model";
    props.onDetailOpenChange({ kind, kindLabel: label, kindOnSelect: () => { void navigateModelsRoute(modelsLocation(route.page, route.modelId)); }, workproductLabel: selected?.name ?? (route.modelId ? "Unavailable model" : null), segments: route.resourceId ? [{ label: route.resourceId }, ...(route.detailTab ? [{ label: route.detailTab }] : [])] : [] });
  }, [route, selected?.name, props.onDetailOpenChange]);

  const open = (next: ModelsRoute) => { void navigateModelsRoute(next); };
  const toast = (message: string, tone: "success" | "info" | "error" = "info") => profileView.onToast?.(message, tone) ?? 0;
  const openTaskset = (id: string | null) => open(modelsLocation("tasksets", route?.modelId ?? null, { resourceId: id }));
  function openTasksetChat(taskset?: { id: string; name: string; objective: string } | null) {
    const returnTo = route ? modelsPath(route) : "/models/tasksets";
    profileView.onSkillCommand?.(`$openpond-taskset-authoring ${taskset ? `Improve the ${taskset.name} Taskset (${taskset.id}).` : "Create a Taskset."} Save through the Taskset draft/publication operations and return to ${returnTo}.`, "openpond");
  }
  async function createModel(input: LabModelCreateInput): Promise<boolean> {
    const saved = await training.training.actions.saveModelProject({ ...newProject(profileId, input.description, undefined, input.name), defaultBaseModel: input.defaultBaseModel });
    if (!saved) return false;
    setModelCreateOpen(false);
    open(modelsLocation());
    toast(`${saved.name} created.`, "success");
    return true;
  }
  async function createScorer(input: LabScorerCreateInput): Promise<boolean> {
    const result = await training.training.actions.createScorer(input.grader, input.tasksetId, route?.modelId ?? null);
    if (!result) return false;
    toast(result.hostedSync.state === "sync_failed" ? `${input.grader.label} saved locally; hosted sync needs attention.` : `${input.grader.label} saved.`, result.hostedSync.state === "sync_failed" ? "info" : "success");
    return true;
  }
  function useModel(id: string) {
    const model = models.find((model) => model.id === id);
    if (!model) return;
    const versions = labModelVersions(model, createImprove.runs, state);
    const version = versions.find((version) => version.current) ?? versions.find((version) => version.lineage.promotable);
    if (version?.taskset) training.onChatWithModel(buildTrainingModelChatHandoff({ modelId: version.lineage.id, taskset: version.taskset }));
  }
  function startRun(tasksetId?: string, reward?: LearnedPreferenceRewardBinding | null) {
    if (route?.modelId) {
      props.onNewModel(tasksetId, reward, route.modelId);
      open(modelsLocation("runs", route.modelId, { collection: "new", resourceId: route.modelId }));
      return;
    }
    setSelectedRunTarget("");
    setRunTarget({ tasksetId, reward });
  }
  function finishRunEditor() {
    if (training.launchRequest) training.onLaunchHandled(training.launchRequest.id);
    open(modelsLocation("runs", route?.modelId ?? null));
  }
  const scopedState = useMemo(() => modelScopedResources(state, route?.modelId ?? null), [state, route?.modelId]);
  const unavailable = (message: string, back = () => open(modelsLocation(route?.page ?? "models"))) => <div className="labs-table-empty" role="status"><p>{message}</p><button className="training-button secondary" type="button" onClick={back}>Return to {route ? MODELS_PAGE_LABELS[route.page] : "Models"}</button></div>;
  let page: ReactNode;
  if (workspaceChanged) page = <p role="status">Loading workspace…</p>;
  else if (!route) page = unavailable("This Models location is unavailable.");
  else if (route.modelId && !state) page = <p role="status">Loading model…</p>;
  else if (route.modelId && !selected) page = unavailable("This model is not available in the active profile and team.");
  else if (route.page === "runs" && route.collection === "new") {
    const target = models.find((model) => model.id === route.resourceId);
    page = !target ? unavailable("The target model for this run setup is unavailable.") : <ModelRunEditorPage
      key={`${workspaceKey}:${target.id}`} connection={profileView.connection} initialModelId={target.id} initialName={target.name}
      initialObjective={training.launchRequest?.initialModelId === target.id ? training.launchRequest.objective ?? target.description : target.description} initialTasksetId={training.launchRequest?.initialModelId === target.id ? training.launchRequest.initialTasksetId : undefined}
      initialLearnedPreferenceReward={training.launchRequest?.initialModelId === target.id ? training.launchRequest.learnedPreferenceReward : null} profileId={profileId} training={training.training}
      onCancel={finishRunEditor} onSaved={finishRunEditor}
      onFinished={async (modelId) => { if (training.launchRequest) training.onLaunchHandled(training.launchRequest.id); await createImprove.refresh(); open(modelsLocation("runs", modelId)); }}
      onOpenProviderSettings={training.onOpenProviderSettings}
      renderDatasetBuilder={(onCreated, onUseExisting) => <TasksetDraftEditor defaultModel={training.defaultModel} modelProjectId={target.id} training={training.training} onBack={onUseExisting} onOpenChat={openTasksetChat} onPublished={onCreated} onUseExistingTaskset={onUseExisting} />}
    />;
  } else if (route.page === "tasksets") {
    page = <><ModelsLocalViews route={route} views={[["default", "Tasksets"], ["formats", "Task formats"], ["batches", "Approved batches"]]} />{route.collection === "formats" ? <LearningTaskFormatsPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} onReview={(id) => open(modelsLocation("evaluations", route.modelId, { collection: "review", resourceId: id }))} /> : route.collection === "batches" ? <LearningBatchesPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} onTrain={async (batch) => { const taskset = await training.training.actions.prepareLearningBatch(batch.id); if (!taskset) throw new Error("The batch could not be prepared. Check the training error for details."); startRun(taskset.id); }} /> : route.collection === "drafts" ? <TasksetDraftEditor
      key={`${workspaceKey}:${route.resourceId}`} draftId={route.resourceId} defaultModel={training.defaultModel} modelProjectId={route.modelId}
      training={training.training} onBack={() => openTaskset(null)} onOpenChat={openTasksetChat} onPublished={openTaskset}
    /> : <LabDatasetsPage
      defaultModel={training.defaultModel} detailTab={route.detailTab as TasksetDetailTab | null} modelProjectId={route.modelId}
      runs={createImprove.runs} selectedId={route.resourceId} state={state} training={training.training}
      onDetailTabChange={(tab) => open(modelsResourceLocation(route, route.resourceId, tab))} onSelectedIdChange={openTaskset}
      onImproveInChat={openTasksetChat} onCreateTaskset={() => setImportSource("source")}
      onOpenDraft={(id) => open(modelsLocation("tasksets", route.modelId, { collection: "drafts", resourceId: id }))}
      onOpenFiles={(id) => { training.onSelectedTasksetIdChange(id); training.onOpenTasksetFiles(); }} onToast={toast} onTrainModel={startRun}
    />}</>;
  } else if (route.page === "rewards") {
    page = <><ModelsLocalViews route={route} views={[["default", "Reusable Rewards"], ["scorers", "Taskset graders"]]} />{route.collection === "scorers" ? <LabScoringPage busy={training.training.busyAction === "create-scorer"} defaultModel={training.defaultModel} onOpenTaskset={openTaskset} onCreateScorer={createScorer} onSelectedScorerIdChange={(id) => open(modelsResourceLocation(route, id))} selectedScorerId={route.resourceId} providerSettings={training.providerSettings} state={scopedState} /> : <LearningRewardsPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} />}</>;
  } else if (route.page === "evaluations") {
    page = <>
      <ModelsLocalViews route={route} views={[["results", "Results"], ["review", "Example review"], ["comparisons", "Comparison review"]]} />
      {route.collection === "review" ? <LearningReviewPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} onBatches={() => open(modelsLocation("tasksets", route.modelId, { collection: "batches" }))} /> : route.collection === "comparisons" ? <LabHumanReviewsPage key={`${workspaceKey}:${route.modelId ?? "all"}`} defaultModel={training.defaultModel} onOpenSeries={(id) => open(modelsLocation("runs", route.modelId, { collection: "series", resourceId: id }))} onToast={toast} onSelectedTasksetIdChange={(id) => open(modelsResourceLocation(route, id))} selectedTasksetId={route.resourceId} state={scopedState} training={training.training} /> : <LabEvaluationsPage
        detailTab={route.detailTab as EvaluationDetailTab | null} modelProjectId={route.modelId}
        onDetailTabChange={(tab) => open(modelsResourceLocation(route, route.resourceId, tab))} onSelectedEvaluationIdChange={(id) => open(modelsResourceLocation(route, id))}
        selectedEvaluationId={route.resourceId} state={state} training={training.training} onToast={toast}
      />}
    </>;
  } else if (route.page === "serving") {
    page = <LabServingPage modelProjectId={route.modelId} state={state} />;
  } else if (route.page === "runs" && route.collection === "series") {
    page = <>
      <ModelsLocalViews route={route} views={[["default", "Runs"], ["series", "Series"]]} />
      <LabModelComparisonsPage connection={profileView.connection} state={scopedState} training={training.training} selectedSeriesId={route.resourceId} selectedEntryId={route.detailTab}
        onSelectedSeriesIdChange={(id) => open(modelsResourceLocation(route, id))} onSelectedEntryIdChange={(id, entryId) => open(modelsResourceLocation(route, id, entryId))}
        onOpenEvaluation={(id) => open(modelsLocation("evaluations", route.modelId, { resourceId: id }))} onOpenProject={(id) => open(modelsLocation("models", id))}
        onOpenTaskset={openTaskset} onOpenRun={(_modelId, id) => open(modelsLocation("runs", route.modelId, { resourceId: `model-run:${id}` }))}
        onOpenVersion={(_modelId, id) => open(modelsLocation("versions", route.modelId, { resourceId: `version:${id}` }))} onToast={toast}
      />
    </>;
  } else if (route.page === "models" && !route.modelId) {
    page = <LabModelsPage activeProfileId={profileId} hostedScope={props.account?.state === "signed_in" ? `${props.account.apiBaseUrl}:${props.account.activeProfile?.handle}:${workspaceKey}` : null} items={models} loading={training.training.loading && !models.length} runs={createImprove.runs} state={state} training={training.training}
      onCompare={() => open(modelsLocation("runs", null, { collection: "series" }))} onPulled={(_id, name, runCount) => toast(`${name} pulled with ${runCount} runs.`, "success")}
      onSelect={(key) => { const model = models.find((model) => model.key === key); if (model) open(modelsLocation("models", model.id)); }} onUseModel={useModel}
    />;
  } else if ((route.page === "runs" || route.page === "versions") && !route.modelId && !route.resourceId) {
    page = <>
      {route.page === "runs" ? <ModelsLocalViews route={route} views={[["default", "Runs"], ["series", "Series"]]} /> : null}
      <ModelsAggregatePage page={route.page} state={state} models={models} runs={createImprove.runs} query={route.query} after={route.after}
        onSearch={(query) => open({ ...route, query, after: null })} onPage={(after) => open({ ...route, after })}
        onOpen={(row) => open(modelsResourceLocation(route, row.ref))} onNewRun={() => startRun()}
      />
    </>;
  } else {
    const ownerId = modelResourceOwner(route, state);
    const owner = models.find((model) => model.id === ownerId) ?? null;
    page = owner ? <>
      {route.page === "runs" ? <ModelsLocalViews route={route} views={[["default", "Runs"], ["series", "Series"]]} /> : null}
      <ModelsResourceDetail key={`${workspaceKey}:${owner.id}:${route.page}`} props={props} model={owner} profile={profile} runs={createImprove.runs} route={route} />
    </> : unavailable("This resource is unavailable in the active workspace.", () => open(modelsLocation(route.page, route.modelId)));
  }
  const tab: LabPrimaryTab = route?.page === "models" ? "overview" : route?.page === "runs" ? "training" : route?.page === "evaluations" ? "evals" : route?.page ?? "overview";
  return <LabsView activeTab={tab} showHeader={route?.page === "models" && !route.modelId} onCreateDataset={() => setImportSource("source")} onCreateModel={() => setModelCreateOpen(true)}>
    {page}
    {modelCreateOpen ? <LabModelCreateDialog baseModelCandidates={state?.baseModelCandidates ?? []} busy={training.training.busyAction === "save-model-project"} defaultBenchmarkModel={training.defaultModel} initialName={nextModelName(state?.modelProjects ?? [])} onClose={() => setModelCreateOpen(false)} onCreate={createModel} onManageModels={training.onOpenTrainingSettings} providerSettings={training.providerSettings} /> : null}
    {importSource === "source" ? <DatasetSourcePickerDialog onClose={() => setImportSource(null)} onSelect={async (source) => {
      if (source === "build") { const draft = await training.training.actions.createTasksetDraft(); if (!draft) return; setImportSource(null); open(modelsLocation("tasksets", route?.modelId ?? null, { collection: "drafts", resourceId: draft.id })); }
      else setImportSource(source);
    }} /> : null}
    {importSource === "huggingface" ? <HuggingFaceDatasetImportDialog onBack={() => setImportSource("source")} onClose={() => setImportSource(null)} onImported={async (id) => { setImportSource(null); await training.training.refresh(); openTaskset(id); }} onOpenDatasetStorageSettings={training.onOpenDatasetStorageSettings} training={training.training} /> : null}
    {runTarget ? <AppDialog ariaLabel="Choose model for training" className="labs-rename-dialog" backdropClassName="labs-rename-backdrop" onClose={() => setRunTarget(null)}>
      <h2>Train an existing model</h2><p>Choose the model this run will improve.</p>
      <label>Model<select value={selectedRunTarget} onChange={(event) => setSelectedRunTarget(event.target.value)}><option value="">Choose model</option>{models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>
      {!models.length ? <p>Create a model from Models before starting a run.</p> : null}
      <div className="model-build-actions"><button className="training-button secondary" type="button" onClick={() => setRunTarget(null)}>Cancel</button><button className="training-button" type="button" disabled={!selectedRunTarget} onClick={() => { props.onNewModel(runTarget.tasksetId, runTarget.reward, selectedRunTarget); setRunTarget(null); open(modelsLocation("runs", selectedRunTarget, { collection: "new", resourceId: selectedRunTarget })); }}>Continue</button></div>
    </AppDialog> : null}
  </LabsView>;
}

function ModelsLocalViews({ route, views }: { route: ModelsRoute; views: Array<[ModelsRoute["collection"], string]> }) {
  return <nav className="taskset-draft-tabs" aria-label={`${MODELS_PAGE_LABELS[route.page]} views`}>{views.map(([collection, label]) => <button type="button" key={collection} aria-current={route.collection === collection ? "page" : undefined} className={route.collection === collection ? "active" : undefined} onClick={() => { void navigateModelsRoute(modelsLocation(route.page, route.modelId, { collection })); }}>{label}</button>)}</nav>;
}
