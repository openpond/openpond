import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AccountState,
  type ChatModelRef,
  type CreateImproveCandidate,
  type CreateImproveRun,
  type LearnedPreferenceRewardBinding,
  type WorkspaceDiffSummary,
} from "@openpond/contracts";

import type { ProfileViewProps } from "../profile/ProfileView";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import {
  DatasetSourcePickerDialog,
  type DatasetCreateSource,
} from "../datasets/DatasetSourcePickerDialog";
import { HuggingFaceDatasetImportDialog } from "../datasets/HuggingFaceDatasetImportDialog";
import { TasksetDraftEditor } from "../datasets/TasksetDraftEditor";
import { ModelUseDialog } from "../training/ModelUseDialog";
import { api } from "../../api";
import { useCreateImproveRuns } from "../../hooks/useCreateImproveRuns";
import { LabWorkproductDetail } from "./LabWorkproductDetail";
import {
  labWorkproductProjection,
  workproductKey,
} from "./lab-workproducts";
import type { LabSkillSourceSelection } from "./lab-skill-source";
import type {
  LabDetailKind,
  LabDetailLocation,
} from "./lab-detail-navigation";
import { LabsView, type LabPrimaryTab } from "./LabsView";
import { LabDatasetsPage } from "./LabDatasetsPage";
import {
  LabModelCreateDialog,
  type LabModelCreateInput,
} from "./LabModelCreateDialog";
import { LabModelsPage } from "./LabModelsPage";
import { LabServingPage } from "./LabServingPage";
import { ModelRunEditorPage } from "./ModelRunEditorPage";
import { labModelVersions } from "./lab-models";
import {
  newProject,
  nextModelName,
} from "./model-run-editor-helpers";
import { buildTrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { useErrorToast } from "../../app/AppToastContext";
import {
  trainingModelRunSyncKey,
} from "./LabsRouteSections";
import {
  LAB_PRIMARY_TAB_CHANGE_EVENT,
  labPrimaryTabFromSearch,
  searchWithLabPrimaryTab,
} from "./lab-primary-tab-state";

export type LabsRouteProps = {
  account: AccountState | null;
  closeDetailKind: LabDetailKind | null;
  closeDetailRequestId: number;
  onNewModel: (
    initialTasksetId?: string,
    learnedPreferenceReward?: LearnedPreferenceRewardBinding | null,
  ) => void;
  onUseAgent: (actionId: string, agentName: string) => void;
  onCreateAgent: (
    objective: string,
    authoringRunId?: string | null,
    authoringModel?: ChatModelRef | null,
  ) => Promise<void>;
  onImproveAgent: (
    agentId: string,
    objective: string,
    agentName?: string | null,
    authoringRunId?: string | null,
    authoringModel?: ChatModelRef | null,
  ) => Promise<void>;
  onOpenRunConversation: (conversationId: string) => void;
  onDetailOpenChange: (location: LabDetailLocation | null) => void;
  onSkillSelectionChange: (selection: LabSkillSourceSelection | null) => void;
  profileView: ProfileViewProps;
  training: TrainingWorkspaceProps;
  onAnswerQuestion: (
    input: { run: CreateImproveRun },
    questionId: string,
    answerValue: string
  ) => Promise<void>;
  onApprove: (input: { run: CreateImproveRun }) => Promise<void>;
  onApplyCandidate: (
    input: { run: CreateImproveRun },
    candidateId: string
  ) => Promise<void>;
  onCancel: (input: { run: CreateImproveRun }) => Promise<void>;
  candidateReview: {
    diff: WorkspaceDiffSummary | null;
    error: string | null;
    loading: boolean;
  };
  onCandidateReviewChange: (
    input: {
      run: CreateImproveRun;
      candidate: CreateImproveCandidate;
      fileRootPath: string | null;
      initialPath: string | null;
    } | null
  ) => void;
  onOpenCandidateFiles: () => void;
  onOpenPullRequest: (
    input: { run: CreateImproveRun },
    candidateId: string
  ) => Promise<void>;
  onPause: (input: { run: CreateImproveRun }) => Promise<void>;
  onReconcilePullRequest: (
    input: { run: CreateImproveRun },
    candidateId: string
  ) => Promise<void>;
  onRejectCandidate: (
    input: { run: CreateImproveRun },
    candidateId: string
  ) => Promise<void>;
  onResume: (input: { run: CreateImproveRun }) => Promise<void>;
  onRevise: (
    input: { run: CreateImproveRun },
    revision: string
  ) => Promise<void>;
};

export function LabsRoute({
  closeDetailKind,
  closeDetailRequestId,
  onAnswerQuestion,
  onApplyCandidate,
  onApprove,
  onCancel,
  candidateReview,
  onCandidateReviewChange,
  onDetailOpenChange,
  onSkillSelectionChange,
  onNewModel,
  onOpenPullRequest,
  onOpenCandidateFiles,
  onOpenRunConversation,
  onPause,
  onReconcilePullRequest,
  onRejectCandidate,
  onResume,
  onRevise,
  profileView,
  training,
}: LabsRouteProps) {
  const profile = profileView.payload?.profile ?? null;
  const profileId = profile?.activeProfile ?? "default";
  const createImprove = useCreateImproveRuns({
    connection: profileView.connection,
    profileId,
  });
  useErrorToast(createImprove.error);
  useErrorToast(training.training.error);
  const modelRunSyncKey = useMemo(
    () => trainingModelRunSyncKey(training.training.payload),
    [training.training.payload]
  );
  const profileAgentRunSyncKey = useMemo(
    () => createImprove.runs
      .filter((run) =>
        run.target.kind === "agent"
        && ["ready_local", "released", "published_hosted"].includes(run.state)
      )
      .map((run) => `${run.id}:${run.revision}:${run.state}`)
      .sort()
      .join("|"),
    [createImprove.runs]
  );
  const [activeTab, setActiveTab] = useState<LabPrimaryTab>(() =>
    typeof window === "undefined"
      ? "overview"
      : labPrimaryTabFromSearch(window.location.search),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(
    null,
  );
  const [modelCreateOpen, setModelCreateOpen] = useState(false);
  const [benchmarkLaunch, setBenchmarkLaunch] = useState<{
    modelId: string;
    model: ChatModelRef;
  } | null>(null);
  const [datasetCreateRoute, setDatasetCreateRoute] = useState<
    "source" | DatasetCreateSource | null
  >(null);
  const [datasetDraftId, setDatasetDraftId] = useState<string | null>(null);
  const [modelEditorSection, setModelEditorSection] = useState<"run" | "dataset">("run");
  const [modelEditorName, setModelEditorName] = useState<string | null>(null);
  const [modelUseVersionId, setModelUseVersionId] = useState<string | null>(
    null
  );

  const workproducts = useMemo(
    () =>
      labWorkproductProjection({
        profile,
        training: training.training.payload,
        runs: createImprove.runs,
      }),
    [createImprove.runs, profile, training.training.payload]
  );
  const models = useMemo(
    () => workproducts.filter((workproduct) => workproduct.kind === "model"),
    [workproducts],
  );
  const selected =
    models.find((workproduct) => workproduct.key === selectedKey) ?? null;
  const modelProjects = training.training.payload?.modelProjects ?? [];
  useEffect(() => {
    if (selected || !models.length) return;
    setSelectedKey(models[0]!.key);
  }, [models, selected]);

  useEffect(() => {
    if (!profileView.connection) return;
    let cancelled = false;
    void api.bootstrap(profileView.connection)
      .then((payload) => {
        if (!cancelled) profileView.onPayload(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          profileView.onError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileView.connection, profileView.onError, profileView.onPayload]);
  useEffect(() => {
    const onPopState = () => {
      setSelectedKey(null);
      setSelectedDatasetId(null);
      setActiveTab(labPrimaryTabFromSearch(window.location.search));
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener(LAB_PRIMARY_TAB_CHANGE_EVENT, onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(LAB_PRIMARY_TAB_CHANGE_EVENT, onPopState);
    };
  }, []);
  useEffect(() => {
    const search = searchWithLabPrimaryTab(window.location.search, activeTab);
    const nextUrl = `${window.location.pathname}${search}${window.location.hash}`;
    const currentUrl =
      `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;
    window.history.replaceState(window.history.state, "", nextUrl);
    window.dispatchEvent(new Event(LAB_PRIMARY_TAB_CHANGE_EVENT));
  }, [activeTab]);
  useEffect(() => {
    if (!modelRunSyncKey) return;
    void createImprove.refresh();
  }, [createImprove.refresh, modelRunSyncKey]);
  useEffect(() => {
    if (!profileAgentRunSyncKey || !profileView.connection) return;
    let cancelled = false;
    void api.bootstrap(profileView.connection)
      .then((payload) => {
        if (!cancelled) profileView.onPayload(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          profileView.onError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileAgentRunSyncKey, profileView.connection, profileView.onError, profileView.onPayload]);
  useEffect(() => {
    if (
      selectedKey &&
      !workproducts.some((workproduct) => workproduct.key === selectedKey)
    ) {
      setSelectedKey(null);
    }
  }, [selectedKey, workproducts]);
  useEffect(() => {
    onSkillSelectionChange(null);
  }, [onSkillSelectionChange]);
  useEffect(() => {
    if (closeDetailRequestId <= 0) return;
    setSelectedKey(null);
    setSelectedDatasetId(null);
    if (closeDetailKind === "dataset") {
      setActiveTab("tasksets");
      return;
    }
    setActiveTab("overview");
  }, [closeDetailKind, closeDetailRequestId]);
  useEffect(() => {
    setModelEditorName(null);
  }, [training.launchRequest?.id]);
  useEffect(() => {
    if (training.launchRequest) {
      onDetailOpenChange({
         kind: "model",
         kindLabel: "Models",
         kindOnSelect: () => document.getElementById("model-run-editor-cancel")?.click(),
         workproductLabel: null,
         segments: [
           { label: modelEditorName ?? "Model" },
           ...(modelEditorSection === "dataset" ? [{ label: "New Taskset" }] : []),
         ],
      });
      return;
    }
    if (activeTab === "tasksets") {
      onDetailOpenChange(
        datasetCreateRoute === "build"
          ? {
              kind: "dataset",
              kindLabel: "Tasksets",
              workproductLabel: null,
              segments: [{ label: "New Taskset" }],
            }
          : selectedDatasetId
          ? {
              kind: "dataset",
              kindLabel: "Tasksets",
              workproductLabel:
                [
                  ...(training.training.payload?.tasksets ?? []),
                  ...(training.training.payload?.modelTasksets ?? []),
                ].find(
                  (taskset) => taskset.id === selectedDatasetId,
                )?.name ?? "Taskset",
              segments: [],
            }
          : null,
      );
      return;
    }
    if (!["overview", "versions", "runs", "rollouts"].includes(activeTab)) {
      onDetailOpenChange(null);
      return;
    }
    if (!selected) onDetailOpenChange(null);
  }, [
    activeTab,
    datasetCreateRoute,
    onDetailOpenChange,
    selected,
    selectedDatasetId,
    modelEditorSection,
    modelEditorName,
    training.launchRequest,
    training.training.payload?.modelTasksets,
    training.training.payload?.tasksets,
  ]);
  useEffect(() => () => onDetailOpenChange(null), [onDetailOpenChange]);

  function useModel(modelId: string) {
    const workproduct = workproducts.find(
      (candidate) => candidate.kind === "model" && candidate.id === modelId,
    );
    if (!workproduct) return;
    const versions = labModelVersions(
      workproduct,
      createImprove.runs,
      training.training.payload,
    );
    const version =
      versions.find((candidate) => candidate.current) ??
      versions.find((candidate) => candidate.lineage.promotable) ??
      null;
    if (!version?.taskset) return;
    training.onChatWithModel(
      buildTrainingModelChatHandoff({
        modelId: version.lineage.id,
        taskset: version.taskset,
      })
    );
  }

  function openDatasetCreation() {
    setDatasetCreateRoute("source");
    setDatasetDraftId(null);
    setSelectedDatasetId(null);
    setActiveTab("tasksets");
  }

  function closeDatasetCreation() {
    setDatasetCreateRoute(null);
    setDatasetDraftId(null);
  }

  function openDatasetBuilderChat(taskset?: {
    id: string;
    name: string;
    objective: string;
  } | null) {
    const target = taskset
      ? `Help me improve the ${taskset.name} Taskset.`
      : "Help me create a Taskset.";
    profileView.onSkillCommand?.(
      `$openpond-taskset-authoring ${target}`,
      "openpond",
    );
    closeDatasetCreation();
  }

  function finishDatasetCreation(tasksetId: string | null) {
    setDatasetCreateRoute(null);
    setDatasetDraftId(null);
    setSelectedKey(null);
    setActiveTab("tasksets");
    setSelectedDatasetId(tasksetId);
  }

  function openModelRunEditor(
    initialTasksetId?: string,
    learnedPreferenceReward?: LearnedPreferenceRewardBinding | null,
  ) {
    setModelEditorSection("run");
    setSelectedKey(null);
    onNewModel(initialTasksetId, learnedPreferenceReward);
  }

  async function createModel(input: LabModelCreateInput): Promise<boolean> {
    const project = {
      ...newProject(profileId, input.description, undefined, input.name),
      defaultBaseModel: input.defaultBaseModel,
    };
    const saved = await training.training.actions.saveModelProject(project);
    if (!saved) return false;
    setModelCreateOpen(false);
    setActiveTab("overview");
    setSelectedKey(workproductKey("model", saved.id));
    if (input.purpose === "benchmark") {
      setBenchmarkLaunch({
        modelId: saved.id,
        model: input.benchmarkModel ?? training.defaultModel,
      });
    }
    profileView.onToast?.(`${saved.name} created.`, "success");
    return true;
  }
  const closeSelectedWorkproduct = useCallback(() => setSelectedKey(null), []);

  function renderLaunchEditor(returnToTasksetId: string | null) {
    const request = training.launchRequest;
    const payload = training.training.payload;
    if (!request || !payload) return null;
    return (
      <ModelRunEditorPage
        connection={profileView.connection}
        initialObjective={request.objective}
        initialTasksetId={request.initialTasksetId}
        initialLearnedPreferenceReward={request.learnedPreferenceReward}
        profileId={profileId}
        training={training.training}
        onCancel={() => {
          training.onLaunchHandled(request.id);
        }}
        onFinished={async (modelId, tasksetId) => {
          training.onSelectedTasksetIdChange(tasksetId);
          training.onDetailTasksetIdChange(tasksetId);
          training.onLaunchHandled(request.id);
          if (returnToTasksetId) {
            setSelectedDatasetId(tasksetId);
            setActiveTab("tasksets");
          } else {
            setSelectedKey(workproductKey("model", modelId));
            setActiveTab("overview");
          }
          await createImprove.refresh();
        }}
        onNameChange={setModelEditorName}
        onSectionChange={setModelEditorSection}
        onSaved={async (modelId) => {
          training.onLaunchHandled(request.id);
          if (returnToTasksetId) {
            setSelectedDatasetId(returnToTasksetId);
            setActiveTab("tasksets");
          } else {
            setSelectedKey(workproductKey("model", modelId));
            setActiveTab("overview");
          }
        }}
        onOpenProviderSettings={training.onOpenProviderSettings}
        renderDatasetBuilder={(onCreated, onUseExistingDataset) => (
          <TasksetDraftEditor
            defaultModel={training.defaultModel}
            modelProjectId={selected?.id ?? null}
            training={training.training}
            onBack={onUseExistingDataset}
            onOpenChat={openDatasetBuilderChat}
            onPublished={onCreated}
            onUseExistingTaskset={onUseExistingDataset}
          />
        )}
      />
    );
  }

  return (
    <LabsView
      activeTab={activeTab}
      showHeader={
        !training.launchRequest
        && datasetCreateRoute !== "build"
      }
      onCreateDataset={openDatasetCreation}
      onCreateModel={() => setModelCreateOpen(true)}
      modelProjects={modelProjects}
      selectedModelProjectId={selected?.id ?? null}
      onSelectModelProject={(modelProjectId) => {
        setSelectedKey(workproductKey("model", modelProjectId));
        setSelectedDatasetId(null);
      }}
    >
      {activeTab === "tasksets" && training.launchRequest ? (
        renderLaunchEditor(selectedDatasetId)
      ) : activeTab === "tasksets" ? (
        datasetCreateRoute === "build" ? (
          <TasksetDraftEditor
            defaultModel={training.defaultModel}
            draftId={datasetDraftId}
            modelProjectId={selected?.id ?? null}
            training={training.training}
            onBack={closeDatasetCreation}
            onOpenChat={openDatasetBuilderChat}
            onPublished={finishDatasetCreation}
          />
        ) : (
          <LabDatasetsPage
            defaultModel={training.defaultModel}
            runs={createImprove.runs}
            selectedId={selectedDatasetId}
            state={training.training.payload}
            training={training.training}
            onToast={(message, tone) =>
              profileView.onToast?.(message, tone) ?? 0
            }
            onSelectedIdChange={setSelectedDatasetId}
            modelProjectId={selected?.id ?? null}
            onOpenDraft={(draftId) => {
              setDatasetDraftId(draftId);
              setDatasetCreateRoute("build");
            }}
            onImproveInChat={(taskset) => openDatasetBuilderChat(taskset)}
            onTrainModel={openModelRunEditor}
            onOpenFiles={(tasksetId) => {
              training.onSelectedTasksetIdChange(tasksetId);
              training.onOpenTasksetFiles();
            }}
          />
        )
      ) : activeTab === "serving" ? (
        <LabServingPage
          state={training.training.payload}
        />
      ) : training.launchRequest ? (
        renderLaunchEditor(null)
      ) : selected ? (
        <LabWorkproductDetail
          connection={profileView.connection}
          profile={profile}
          runs={createImprove.runs}
          training={training.training}
          workproduct={selected}
          modelSection={activeTab}
          onAnswerQuestion={onAnswerQuestion}
          onApplyCandidate={onApplyCandidate}
          onApprove={onApprove}
          onCancel={onCancel}
          candidateReview={candidateReview}
          onCandidateReviewChange={onCandidateReviewChange}
          onChatWithModel={training.onChatWithModel}
          onOpenPullRequest={onOpenPullRequest}
          onOpenCandidateFiles={onOpenCandidateFiles}
          onOpenConversation={onOpenRunConversation}
          onClose={closeSelectedWorkproduct}
          onLocationChange={onDetailOpenChange}
          onRenameAgent={() => undefined}
          onOpenDataset={(tasksetId) => {
            setSelectedKey(null);
            setSelectedDatasetId(tasksetId);
            setActiveTab("tasksets");
          }}
          onPause={onPause}
          onReconcilePullRequest={onReconcilePullRequest}
          onRejectCandidate={onRejectCandidate}
          onResume={onResume}
          onRevise={onRevise}
          renderModelRunEditor={({
            initialTasksetId,
            draftId,
            modelId,
            modelName,
            onCancel: cancelBuild,
            onFinished: finishBuild,
            onSectionChange,
          }) => (
            <ModelRunEditorPage
              connection={profileView.connection}
              initialModelId={modelId}
              initialName={modelName}
              initialDraftId={draftId ?? undefined}
              initialObjective={selected.description}
              initialTasksetId={initialTasksetId ?? undefined}
              profileId={profileId}
              training={training.training}
              onCancel={cancelBuild}
              onFinished={async () => {
                await createImprove.refresh();
                await finishBuild();
              }}
              onSectionChange={onSectionChange}
              onOpenProviderSettings={training.onOpenProviderSettings}
              renderDatasetBuilder={(onCreated, onUseExistingDataset) => (
                <TasksetDraftEditor
                  defaultModel={training.defaultModel}
                  modelProjectId={selected.id}
                  training={training.training}
                  onBack={onUseExistingDataset}
                  onOpenChat={openDatasetBuilderChat}
                  onPublished={onCreated}
                  onUseExistingTaskset={onUseExistingDataset}
                />
              )}
            />
          )}
          onStartAgentChange={() => undefined}
          onToast={training.onToast}
          benchmarkDefaultModel={training.defaultModel}
          benchmarkProviderSettings={training.providerSettings}
          initialBenchmarkModel={
            benchmarkLaunch?.modelId === selected.id
              ? benchmarkLaunch.model
              : null
          }
          initialBenchmarkOpen={benchmarkLaunch?.modelId === selected.id}
          onInitialBenchmarkOpenConsumed={() => setBenchmarkLaunch(null)}
        />
      ) : (
        <LabModelsPage
          activeProfileId={profileId}
          items={models}
          loading={training.training.loading && !models.length}
          providerSettings={training.providerSettings}
          runs={createImprove.runs}
          state={training.training.payload}
          onSelect={setSelectedKey}
          onUseModel={useModel}
        />
      )}

      {modelCreateOpen ? (
        <LabModelCreateDialog
          baseModelCandidates={
            training.training.payload?.baseModelCandidates ?? []
          }
          busy={training.training.busyAction === "save-model-project"}
          defaultBenchmarkModel={training.defaultModel}
          initialName={nextModelName(
            training.training.payload?.modelProjects ?? [],
          )}
          onClose={() => setModelCreateOpen(false)}
          onCreate={createModel}
          onManageModels={() => {
            setModelCreateOpen(false);
            training.onOpenTrainingSettings();
          }}
          providerSettings={training.providerSettings}
        />
      ) : null}
      {datasetCreateRoute === "source" ? (
        <DatasetSourcePickerDialog
          onClose={closeDatasetCreation}
          onSelect={async (source) => {
            if (source === "build") {
              const created = await training.training.actions.createTasksetDraft();
              if (!created) return;
              setDatasetDraftId(created.id);
              setDatasetCreateRoute("build");
              return;
            }
            setDatasetCreateRoute(source);
          }}
        />
      ) : null}
      {datasetCreateRoute === "huggingface" ? (
        <HuggingFaceDatasetImportDialog
          onBack={() => setDatasetCreateRoute("source")}
          onClose={closeDatasetCreation}
          onImported={async (tasksetId) => {
            await training.training.refresh();
            finishDatasetCreation(tasksetId);
          }}
          onOpenDatasetStorageSettings={() => {
            setDatasetCreateRoute(null);
            training.onOpenDatasetStorageSettings();
          }}
          training={training.training}
        />
      ) : null}
      {modelUseVersionId
        ? (() => {
            const lineage = training.training.payload?.models.find(
              (candidate) => candidate.id === modelUseVersionId,
            );
            const taskset = training.training.payload?.tasksets.find(
              (candidate) => candidate.id === lineage?.tasksetId,
            );
            if (!lineage || !taskset) return null;
            return (
              <ModelUseDialog
                lineage={lineage}
                taskset={taskset}
                training={training.training}
                onChat={training.onChatWithModel}
                onClose={() => setModelUseVersionId(null)}
              />
            );
          })()
        : null}
    </LabsView>
  );
}
