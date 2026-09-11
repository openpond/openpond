import { LabComparisonSeriesCreateDialog } from "./LabComparisonSeriesCreateDialog";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LearnedPreferenceRewardBinding, TasksetDraft } from "@openpond/contracts";
import { appendTaskIntake, taskIntakeSourceFiles } from "openpond-sdk/taskset-drafts";
import { learningRef, type TaskBatch } from "openpond-sdk/learning";
import { api } from "../../api";
import { useCreateImproveRuns } from "../../hooks/useCreateImproveRuns";
import { useErrorToast } from "../../app/AppToastContext";
import { buildHostedTrainingModelChatHandoff, buildTrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { AppDialog } from "../dialogs/AppDialog";
import { DatasetSourcePickerDialog, type DatasetCreateSource } from "../datasets/DatasetSourcePickerDialog";
import { HuggingFaceDatasetImportDialog } from "../datasets/HuggingFaceDatasetImportDialog";
import { TasksetDraftEditor } from "../datasets/TasksetDraftEditor";
import { TaskIntakeForm } from "./learning/TaskIntakeForm";
import { LabDatasetsPage, type TasksetDetailTab } from "./LabDatasetsPage";
import { HostedModelLearning } from "./learning/HostedModelLearning";
import { LabTasksPage } from "./LabTasksPage";
import { LabEvaluationsPage, type EvaluationDetailTab } from "./LabEvaluationsPage";
import { LabHumanReviewsPage } from "./LabHumanReviewsPage";
import { LabScoringPage } from "./LabScoringPage";
import type { LabScorerCreateInput } from "./LabScorerCreateDialog";
import { LabModelCreateDialog, type LabModelCreateInput } from "./LabModelCreateDialog";
import { ModelStarterCatalog } from "./ModelStarterCatalog";
import { LabModelsPage } from "./LabModelsPage";
import { useHostedModelRefresh } from "./use-hosted-model-refresh";
import { LabModelComparisonsPage } from "./LabModelComparisonsPage";
import { LabServingPage } from "./LabServingPage";
import { LabsView, type LabPrimaryTab } from "./LabsView";
import { ModelRunEditorPage } from "./ModelRunEditorPage";
import { ModelsResourceDetail } from "./ModelsResourceDetail";
import { ModelsAggregatePage } from "./ModelsAggregatePage";
import { LearningRewardsPage } from "./learning/LearningRewardsPage";
import { LearningCombinedRewardsPage } from "./learning/LearningCombinedRewardsPage";
import { LearningTaskFormatsPage } from "./learning/LearningTaskFormatsPage";
import { LearningReviewPage } from "./learning/LearningReviewPage";
import { LearningBatchesPage } from "./learning/LearningBatchesPage";
import { useLearningClient } from "./learning/useLearningResources";
import { modelResourceOwner, modelScopedResources } from "./models-resource-scope";
import { labModelTasksets, labModelVersions } from "./lab-models";
import { labWorkproductProjection } from "./lab-workproducts";
import { newProject, nextModelName } from "./model-run-editor-helpers";
import { computeProfileAgentRunSyncKey, trainingModelRunSyncKey } from "./LabsRouteSections";
import { modelsLocation, modelsPath, modelsResourceLocation, MODELS_PAGE_LABELS, navigateModelsRoute, useModelsRoute, type ModelsRoute } from "./lab-primary-tab-state";
import type { LabsRouteProps } from "./labs-route-types";
import type { ModelStarterPreview } from "../../hooks/useTraining";
export type { LabsRouteProps } from "./labs-route-types";

export function LabsRoute(props: LabsRouteProps) {
  const { profileView, training } = props;
  const [comparisonCreateOpen, setComparisonCreateOpen] = useState(false);
  const profile = profileView.payload?.profile ?? null;
  const profileId = profile?.activeProfile ?? "default";
  const learningClient = useLearningClient(profileView.connection, profileId);
  const createImprove = useCreateImproveRuns({ connection: profileView.connection, profileId });
  const route = useModelsRoute();
  const state = training.training.payload;
  const [modelCreateOpen, setModelCreateOpen] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [starterPreview, setStarterPreview] = useState<ModelStarterPreview | null>(null);
  const savedModelId = useRef<string | null>(null);
  const [importSource, setImportSource] = useState<"source" | DatasetCreateSource | null>(null);
  const intakeBusy = useRef(false);
  const intakeDraft = useRef<{ previewHash: string; draft: TasksetDraft } | null>(null);
  const [runTarget, setRunTarget] = useState<{ tasksetId?: string; reward?: LearnedPreferenceRewardBinding | null } | null>(null);
  const [selectedRunTarget, setSelectedRunTarget] = useState("");
  const workspaceKey = JSON.stringify([profileView.connection?.serverUrl ?? null, profileId, training.settingsPreferences.defaultTeamId ?? null, props.account?.apiBaseUrl ?? null, props.account?.activeProfile?.handle ?? null]);
  // Packaged Desktop chooses a new local API port at launch. Catalog authority
  // is the hosted account/workspace, so its persisted key must survive that port.
  const starterCacheScope = props.account?.state === "signed_in" ? JSON.stringify([props.account.apiBaseUrl, props.account.activeProfile?.handle ?? null, profileId, training.settingsPreferences.defaultTeamId ?? null]) : null;
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
  const hostedRefreshError = useHostedModelRefresh(state?.modelProjects.find(model => model.id === selected?.id) ?? null,
    training.settingsPreferences.defaultTeamId ?? null, props.account?.apiBaseUrl ?? null, training.training);
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
    setStarterPreview(null);
    setComparisonCreateOpen(false);
    setImportSource(null);
    intakeDraft.current = null;
    intakeBusy.current = false;
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
    const kind = route.page === "tasksets" || route.page === "tasks" ? "dataset" : route.page === "rewards" ? "scoring" : route.page === "evaluations" || route.page === "labeling" ? "evaluation" : "model";
    props.onDetailOpenChange({ kind, kindLabel: label, kindOnSelect: () => { void navigateModelsRoute(modelsLocation(route.page, route.modelId)); }, workproductLabel: selected?.name ?? (route.modelId ? "Unavailable model" : null), segments: route.resourceId ? [{ label: route.resourceId }, ...(route.detailTab ? [{ label: route.detailTab }] : [])] : [] });
  }, [route, selected?.name, props.onDetailOpenChange]);

  const open = (next: ModelsRoute) => { void navigateModelsRoute(next); };
  const toast = (message: string, tone: "success" | "info" | "error" = "info") => profileView.onToast?.(message, tone) ?? 0;
  const openTaskset = (id: string | null) => open(modelsLocation("tasks", route?.modelId ?? null, { resourceId: id }));
  function openTasksetChat(taskset?: { id: string; name: string; objective: string } | null) {
    const returnTo = route ? modelsPath(route) : "/models/tasks";
    profileView.onSkillCommand?.(`$openpond-taskset-authoring ${taskset ? `Improve the ${taskset.name} Taskset (${taskset.id}).` : "Create a Taskset."} Save through the Taskset draft/publication operations and return to ${returnTo}.`, "openpond");
  }
  function modelConfiguration(input: LabModelCreateInput) {
    const existing = state?.modelProjects.find((project) => project.id === input.id);
    const project = existing ?? newProject(profileId, input.description, input.id, input.name);
    const previousTaskset = project.trainingSetup.tasksetRef;
    const sameTaskset = previousTaskset?.id === input.tasksetRef?.id && previousTaskset?.revision === input.tasksetRef?.revision && previousTaskset?.contentHash === input.tasksetRef?.contentHash;
    return { ...project, name: input.name, objective: input.description, defaultBaseModel: input.defaultBaseModel, trainingSetup: { ...project.trainingSetup, recipe: input.recipe, baseModel: input.defaultBaseModel, rewardBindingRef: input.rewardBindingRef, tasksetRef: input.tasksetRef, tasksetRelease: sameTaskset ? project.trainingSetup.tasksetRelease : null, ...(!sameTaskset ? { recipe: null, method: null } : {}) } };
  }
  async function createModel(input: LabModelCreateInput): Promise<boolean> {
    const saved = input.starterRequest ? await training.training.actions.createModelFromStarter(input.starterRequest) : await training.training.actions.saveModelProject(modelConfiguration(input), input.expectedRevision);
    if (!saved) return false;
    savedModelId.current = saved.id;
    toast(`${saved.name} ${input.expectedRevision ? "updated" : "created"}.`, "success");
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
    if (!version) return;
    if (version.taskset) training.onChatWithModel(buildTrainingModelChatHandoff({ modelId: version.lineage.id, taskset: version.taskset }));
    else if (version.current && version.lineage.managedServing) training.onChatWithModel(buildHostedTrainingModelChatHandoff({
      modelId: version.lineage.id, tasksetId: version.lineage.tasksetId, modelName: model.name,
    }));
  }
  async function attachBatch(batch: TaskBatch) {
    const project = state?.modelProjects.find(project => project.id === route?.modelId);
    if (!project) throw new Error("The selected Model is unavailable.");
    const taskset = await training.training.actions.prepareLearningBatch(batch.id);
    if (!taskset) throw new Error("The reviewed batch could not be prepared.");
    const saved = await training.training.actions.saveModelProject({ ...project, trainingSetup: { ...project.trainingSetup,
      tasksetRef: learningRef(taskset), rewardBindingRef: null, tasksetRelease: null, recipe: null, method: null,
    } }, project.revision);
    if (!saved) throw new Error("The Model could not be updated. Refresh it before retrying.");
    toast("Reviewed batch selected for this Model.", "success");
    openTaskset(taskset.id);
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
  else if (route.page === "get-started") {
    page = <div className="labs-flat-body"><ModelStarterCatalog key={workspaceKey} cacheScope={starterCacheScope} actions={training.training.actions} onSelect={(preview) => { setStarterPreview(preview); setEditingModelId(null); setModelCreateOpen(true); }} onImport={setImportSource} onCreate={() => { setStarterPreview(null); setEditingModelId(null); setModelCreateOpen(true); }} /></div>;
  } else if (route.page === "runs" && route.collection === "new") {
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
  } else if (route.page === "settings") {
    const project = state?.modelProjects.find(project => project.id === route.modelId);
    page = project ? <LabModelCreateDialog key={`${workspaceKey}:${project.id}:settings`} presentation="page" project={project} tasksets={labModelTasksets(state).filter(taskset => taskset.profileId === profileId)} learningClient={learningClient} baseModelCandidates={state?.baseModelCandidates ?? []} busy={training.training.busyAction === "save-model-project"} initialName={project.name} onClose={() => open(modelsLocation("models", project.id))} onCheck={input => training.training.actions.checkModelProject(modelConfiguration(input), input.expectedRevision)} onCreate={createModel} onSaved={() => toast("Settings saved.", "success")} onManageModels={training.onOpenTrainingSettings} renderTasksetBuilder={(onPublished, onClose, closeRef) => <TasksetDraftEditor closeRef={closeRef} defaultModel={training.defaultModel} training={training.training} onBack={onClose} onPublished={onPublished} />} learningSettings={project.hosted && profileView.connection ? <HostedModelLearning connection={profileView.connection} model={project} readOnly={false} mode="settings" /> : <section><h2>Continual learning</h2><p>Connect this model to a hosted team from the model page to configure continual learning.</p></section>} /> : unavailable("This model is unavailable.");
  } else if (route.page === "tasks") {
    page = route.collection === "drafts" ? <TasksetDraftEditor key={`${workspaceKey}:${route.resourceId}`} draftId={route.resourceId} defaultModel={training.defaultModel} modelProjectId={route.modelId} training={training.training} onBack={() => openTaskset(null)} onOpenChat={openTasksetChat} onPublished={openTaskset} />
      : <LabTasksPage key={`${workspaceKey}:${route.modelId ?? "all"}`} state={state} training={training.training} modelId={route.modelId} client={learningClient} collectionId={state?.tasksets.some(item => item.id === route.resourceId) ? route.resourceId : null} reviewId={state?.tasksets.some(item => item.id === route.resourceId) ? null : route.resourceId} sourceId={route.sourceId} onReview={id => open(modelsResourceLocation(route, id))} onClearSource={() => open({ ...route, sourceId: null, resourceId: null, after: null })} onReward={id => open(modelsLocation("rewards", route.modelId, { collection: "combined", resourceId: id }))} query={route.query} after={route.after}
        onSearch={query => open({ ...route, query, after: null })} onPage={after => open({ ...route, after })} onCollection={resourceId => open({ ...route, resourceId, after: null })} onAdd={() => setImportSource("source")} onOpenDraft={id => open(modelsLocation("tasks", route.modelId, { collection: "drafts", resourceId: id }))} />;
  } else if (route.page === "labeling") {
    page = <LearningReviewPage onReward={id => open(modelsLocation("rewards", route.modelId, { collection: "combined", resourceId: id }))} key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} sourceId={route.sourceId} onClearSource={() => open({ ...route, sourceId: null, resourceId: null, after: null })} onSelect={id => open(modelsResourceLocation(route, id))} onPage={after => open({ ...route, after })} onBatches={() => open(modelsLocation("tasksets", route.modelId, { collection: "batches" }))} />;
  } else if (route.page === "tasksets") {
    page = <><ModelsLocalViews route={route} views={[["default", "Tasksets"], ["formats", "Task formats"], ["batches", "Approved batches"]]} />{route.collection === "formats" ? <LearningTaskFormatsPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} onReview={(id) => open(modelsLocation("evaluations", route.modelId, { collection: "review", resourceId: id }))} /> : route.collection === "batches" ? <LearningBatchesPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} onAttach={route.modelId ? attachBatch : undefined} onTrain={async (batch) => { const taskset = await training.training.actions.prepareLearningBatch(batch.id); if (!taskset) throw new Error("The batch could not be prepared. Check the training error for details."); startRun(taskset.id); }} /> : route.collection === "drafts" ? <TasksetDraftEditor
      key={`${workspaceKey}:${route.resourceId}`} draftId={route.resourceId} defaultModel={training.defaultModel} modelProjectId={route.modelId}
      training={training.training} onBack={() => openTaskset(null)} onOpenChat={openTasksetChat} onPublished={openTaskset}
    /> : <LabDatasetsPage
      defaultModel={training.defaultModel} detailTab={route.detailTab as TasksetDetailTab | null} modelProjectId={route.modelId}
      runs={createImprove.runs} selectedId={route.resourceId} state={state} training={training.training}
      onDetailTabChange={(tab) => open(modelsResourceLocation(route, route.resourceId, tab))} onSelectedIdChange={openTaskset}
      onImproveInChat={openTasksetChat} onCreateTaskset={() => setImportSource("source")}
      onReviewBatch={(id) => open(modelsLocation("evaluations", route.modelId, { collection: "review", resourceId: id }))}
      onOpenDraft={(id) => open(modelsLocation("tasksets", route.modelId, { collection: "drafts", resourceId: id }))}
      onOpenFiles={(id) => { training.onSelectedTasksetIdChange(id); training.onOpenTasksetFiles(); }} onToast={toast} onTrainModel={startRun}
    />}</>;
  } else if (route.page === "rewards") {
    page = <><ModelsLocalViews route={route} views={[["default", "Graders"], ["combined", "Combinations"], ["scorers", "Taskset graders"]]} />{route.collection === "scorers" ? <LabScoringPage busy={training.training.busyAction === "create-scorer"} defaultModel={training.defaultModel} onOpenTaskset={openTaskset} onCreateScorer={createScorer} onSelectedScorerIdChange={(id) => open(modelsResourceLocation(route, id))} selectedScorerId={route.resourceId} providerSettings={training.providerSettings} state={scopedState} /> : route.collection === "combined" ? <LearningCombinedRewardsPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} /> : <LearningRewardsPage key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} />}</>;
  } else if (route.page === "evaluations") {
    page = <>
      {route.collection === "review" ? <LearningReviewPage onReward={id => open(modelsLocation("rewards", route.modelId, { collection: "combined", resourceId: id }))} key={workspaceKey} client={learningClient} selectedId={route.resourceId} after={route.after} sourceId={route.sourceId} onClearSource={() => open({ ...route, sourceId: null, resourceId: null, after: null })} onSelect={(id) => open(modelsResourceLocation(route, id))} onPage={(after) => open({ ...route, after })} onBatches={() => open(modelsLocation("tasksets", route.modelId, { collection: "batches" }))} /> : route.collection === "comparisons" ? <LabHumanReviewsPage key={`${workspaceKey}:${route.modelId ?? "all"}`} defaultModel={training.defaultModel} onOpenSeries={(id) => open(modelsLocation("runs", route.modelId, { collection: "series", resourceId: id }))} onToast={toast} onSelectedTasksetIdChange={(id) => open(modelsResourceLocation(route, id))} selectedTasksetId={route.resourceId} state={scopedState} training={training.training} /> : <LabEvaluationsPage
        detailTab={route.detailTab as EvaluationDetailTab | null} modelProjectId={route.modelId}
        onDetailTabChange={(tab) => open(modelsResourceLocation(route, route.resourceId, tab))} onSelectedEvaluationIdChange={(id) => open(modelsResourceLocation(route, id))}
        selectedEvaluationId={route.resourceId} state={state} training={training.training} onToast={toast}
      />}
    </>;
  } else if (route.page === "serving") {
    page = <LabServingPage modelProjectId={route.modelId} state={state} />;
  } else if (route.page === "runs" && route.collection === "series") {
    page = <>
      <LabModelComparisonsPage connection={profileView.connection} state={scopedState} training={training.training} selectedSeriesId={route.resourceId} selectedEntryId={route.detailTab}
        onSelectedSeriesIdChange={(id) => open(modelsResourceLocation(route, id))} onSelectedEntryIdChange={(id, entryId) => open(modelsResourceLocation(route, id, entryId))}
        onOpenEvaluation={(id) => open(modelsLocation("evaluations", route.modelId, { resourceId: id }))} onOpenProject={(id) => open(modelsLocation("models", id))}
        onOpenTaskset={openTaskset} onOpenRun={(_modelId, id) => open(modelsLocation("runs", route.modelId, { resourceId: `model-run:${id}` }))}
        onOpenVersion={(_modelId, id) => open(modelsLocation("versions", route.modelId, { resourceId: `version:${id}` }))} onToast={toast}
      />
    </>;
  } else if (route.page === "models" && !route.modelId) {
    page = <LabModelsPage onCreate={() => { setStarterPreview(null); setEditingModelId(null); setModelCreateOpen(true); }} activeProfileId={profileId} hostedScope={props.account?.state === "signed_in" ? `${props.account.apiBaseUrl}:${props.account.activeProfile?.handle}:${workspaceKey}` : null} hostedApiOrigin={props.account?.apiBaseUrl ?? null} items={models} loading={training.training.loading && !models.length} runs={createImprove.runs} state={state} training={training.training}
      onCompare={() => open(modelsLocation("runs", null, { collection: "series" }))} onPulled={(_id, name, runCount) => toast(`${name} pulled with ${runCount} runs.`, "success")}
      onOpened={(id) => open(modelsLocation("models", id))}
      onSelect={(key) => { const model = models.find((model) => model.key === key); if (model) open(modelsLocation("models", model.id)); }} onUseModel={useModel} onConfigure={id => open(modelsLocation("settings", id))}
    />;
  } else if ((route.page === "runs" || (route.page === "versions" && !route.modelId)) && !route.resourceId) {
    page = <>
      <ModelsAggregatePage modelId={route.modelId} page={route.page} state={scopedState} models={route.modelId ? models.filter((model) => model.id === route.modelId) : models} runs={createImprove.runs} query={route.query} after={route.after}
        onSearch={(query) => open({ ...route, query, after: null })} onPage={(after) => open({ ...route, after })}
        onOpen={(row) => open(row.ref.startsWith("series:") ? modelsLocation("runs", route.modelId, { collection: "series", resourceId: row.ref.slice(7) }) : modelsResourceLocation(route, row.ref))} onNewRun={() => startRun()} onNewComparison={() => setComparisonCreateOpen(true)}
      />
    </>;
  } else {
    const ownerId = modelResourceOwner(route, state);
    const owner = models.find((model) => model.id === ownerId) ?? null;
    page = owner ? <>
      <ModelsResourceDetail key={`${workspaceKey}:${owner.id}:${route.page}`} props={props} model={owner} profile={profile} runs={createImprove.runs} route={route} />
    </> : unavailable("This resource is unavailable in the active workspace.", () => open(modelsLocation(route.page, route.modelId)));
  }
  const tab: LabPrimaryTab = (route?.page === "models" || route?.page === "settings" || route?.page === "get-started") ? "overview" : route?.page === "runs" ? "training" : route?.page === "evaluations" || route?.page === "labeling" ? "evals" : route?.page === "tasks" ? "tasksets" : route?.page ?? "overview";
  return <LabsView activeTab={tab} showHeader={false} onCreateDataset={() => setImportSource("source")} onCreateModel={() => { setStarterPreview(null); setEditingModelId(null); setModelCreateOpen(true); }}>
    {hostedRefreshError ? <p role="status">{hostedRefreshError}</p> : null}
    {route && (route.page === "runs" || route.page === "evaluations") ? <ModelsRunViews route={route} /> : null}
    {route && ["models", "versions", "serving"].includes(route.page) && (route.modelId || route.page !== "models") ? <ModelsModelViews route={route} /> : null}
    {page}
    {comparisonCreateOpen && scopedState ? <LabComparisonSeriesCreateDialog busy={Boolean(training.training.busyAction)} profileId={scopedState.profileId} state={scopedState} onClose={() => setComparisonCreateOpen(false)} onCreate={async (series) => { const saved = await training.training.actions.saveComparisonSeries(series); if (!saved) return false; setComparisonCreateOpen(false); open(modelsLocation("runs", route?.modelId ?? null, { collection: "series", resourceId: saved.id })); return true; }} /> : null}
    {modelCreateOpen ? <LabModelCreateDialog key={`${workspaceKey}:${editingModelId ?? starterPreview?.starter.contentHash ?? "new"}`} starter={starterPreview ? { preview: starterPreview, profileId } : null} project={state?.modelProjects.find((project) => project.id === editingModelId) ?? null} tasksets={labModelTasksets(state).filter((taskset) => taskset.profileId === profileId)} learningClient={learningClient} baseModelCandidates={state?.baseModelCandidates ?? []} busy={training.training.busyAction === "save-model-project" || training.training.busyAction === "create-model-from-starter"} initialName={nextModelName(state?.modelProjects ?? [])} onClose={() => setModelCreateOpen(false)} onCheck={(input) => input.starterRequest ? training.training.actions.checkModelStarter(input.starterRequest) : training.training.actions.checkModelProject(modelConfiguration(input), input.expectedRevision)} onCreate={createModel} onSaved={() => { setModelCreateOpen(false); setEditingModelId(null); setStarterPreview(null); open(modelsLocation("models", savedModelId.current)); }} onManageModels={training.onOpenTrainingSettings} renderTasksetBuilder={(onPublished, onClose, closeRef) => <TasksetDraftEditor closeRef={closeRef} defaultModel={training.defaultModel} training={training.training} onBack={onClose} onPublished={onPublished} />} /> : null}
    {importSource === "source" ? <DatasetSourcePickerDialog onClose={() => setImportSource(null)} onSelect={async (source) => {
      if (source === "build") { const draft = await training.training.actions.createTasksetDraft("", route?.modelId); if (!draft) return; setImportSource(null); open(modelsLocation("tasks", route?.modelId ?? null, { collection: "drafts", resourceId: draft.id })); }
      else setImportSource(source);
    }} /> : null}
    {importSource === "huggingface" ? <HuggingFaceDatasetImportDialog onBack={() => setImportSource("source")} onClose={() => setImportSource(null)} onImported={async (id) => { setImportSource(null); await training.training.refresh(); openTaskset(id); }} onOpenDatasetStorageSettings={training.onOpenDatasetStorageSettings} training={training.training} /> : null}
    {importSource === "upload" || importSource === "hermes" || importSource === "openclaw" ? <AppDialog ariaLabel="Import tasks" className="labs-rename-dialog labs-model-create-dialog" backdropClassName="labs-rename-backdrop" onClose={() => { if (!intakeBusy.current) setImportSource(null); }}>
      <TaskIntakeForm client={learningClient} initialFormat={importSource === "upload" ? "json" : importSource} onBusyChange={busy => { intakeBusy.current = busy; }} onBack={() => setImportSource("source")}
        onImported={sourceId => { if (priorWorkspace.current !== workspaceKey) return; setImportSource(null); open(modelsLocation("labeling", route?.modelId ?? null, { sourceId })); }}
        onTasks={async ({ preview, files, recordIds, name, signal }) => {
          const retainedFiles = taskIntakeSourceFiles(preview, files);
          let draft = (intakeDraft.current?.previewHash === preview.contentHash ? intakeDraft.current.draft : null) ?? await training.training.actions.createTasksetDraft(name, route?.modelId);
          if (!draft) throw new Error("Could not create the imported task draft.");
          signal.throwIfAborted();
          if (priorWorkspace.current !== workspaceKey) throw new Error("The active workspace changed. Reopen the import in the intended workspace.");
          intakeDraft.current = { previewHash: preview.contentHash, draft };
          const inventory = await training.training.actions.tasksetDraftFiles(draft.id);
          if (!inventory) throw new Error("Could not inspect the imported draft files.");
          for (const file of retainedFiles) {
            signal.throwIfAborted();
            if (inventory.files.some(existing => existing.path === file.path)) {
              const existing = await training.training.actions.tasksetDraftFile(draft.id, file.path);
              if (!existing || existing.file.contentHash !== file.contentHash) throw new Error("A retained import file changed. Import will not overwrite it.");
              continue;
            }
            const updated = await training.training.actions.saveTasksetDraftFile({ draftId: draft.id, expectedDraftRevision: draft.revision,
              path: file.path, expectedFileHash: null, content: file.content });
            if (!updated) throw new Error("Could not retain an import source file. Retry to continue this draft.");
            draft = updated; intakeDraft.current = { previewHash: preview.contentHash, draft: updated };
          }
          signal.throwIfAborted();
          const saved = await training.training.actions.saveTasksetDraft(appendTaskIntake(draft, preview, recordIds));
          if (!saved) throw new Error("The task draft could not be saved. Retry to continue this draft.");
          signal.throwIfAborted();
          if (priorWorkspace.current !== workspaceKey) return;
          intakeDraft.current = null; setImportSource(null); open(modelsLocation("tasks", route?.modelId ?? null, { collection: "drafts", resourceId: saved.id }));
        }} />
    </AppDialog> : null}
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

function ModelsRunViews({ route }: { route: ModelsRoute }) {
  const views = [["runs", "default", "Training"], ["evaluations", "results", "Evaluations"], ["runs", "series", "Experiments"], ["evaluations", "comparisons", "Comparison review"]] as const;
  return <nav className="taskset-draft-tabs" aria-label="Run views">{views.map(([page, collection, label]) => <button type="button" key={label} className={route.page === page && route.collection === collection ? "active" : undefined} aria-current={route.page === page && route.collection === collection ? "page" : undefined} onClick={() => { void navigateModelsRoute(modelsLocation(page, route.modelId, { collection })); }}>{label}</button>)}</nav>;
}

function ModelsModelViews({ route }: { route: ModelsRoute }) {
  return <nav className="taskset-draft-tabs" aria-label="Model views">{([["models", route.modelId ? "Model" : "Models"], ["versions", "Versions"], ["serving", "Serving"]] as const).map(([page, label]) => <button type="button" key={page} className={route.page === page ? "active" : undefined} aria-current={route.page === page ? "page" : undefined} onClick={() => { void navigateModelsRoute(modelsLocation(page, route.modelId)); }}>{label}</button>)}</nav>;
}
