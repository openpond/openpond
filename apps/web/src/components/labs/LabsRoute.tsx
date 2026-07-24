import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isTrainingSourceRef,
  type ChatModelRef,
  type CreateImproveCandidate,
  type CreateImproveRun,
  type Taskset,
  type TaskCreationSnapshot,
  type WorkspaceDiffSummary,
  type TrainingSourceRef,
} from "@openpond/contracts";

import type { InsightsViewProps } from "../insights/InsightsView";
import type { ProfileViewProps } from "../profile/ProfileView";
import { ProfileView } from "../profile/ProfileView";
import type { TrainingViewProps } from "../training/TrainingView";
import { CreateImproveAuthoringDialog } from "../create-improve/CreateImproveAuthoringDialog";
import {
  DatasetSourcePickerDialog,
  type DatasetCreateSource,
} from "../datasets/DatasetSourcePickerDialog";
import { HuggingFaceDatasetImportDialog } from "../datasets/HuggingFaceDatasetImportDialog";
import { ModelUseDialog } from "../training/ModelUseDialog";
import { api } from "../../api";
import { useCreateImproveRuns } from "../../hooks/useCreateImproveRuns";
import { LabWorkproductDetail } from "./LabWorkproductDetail";
import {
  labWorkproductProjection,
  runsForWorkproduct,
  workproductKey,
} from "./lab-workproducts";
import {
  labSkillSourceSelection,
  type LabSkillSourceSelection,
} from "./lab-skill-source";
import type {
  LabDetailKind,
  LabDetailLocation,
} from "./lab-detail-navigation";
import { LabsView, type LabPrimaryTab } from "./LabsView";
import { LabAgentRenameDialog } from "./LabAgentRenameDialog";
import { LabDatasetsPage } from "./LabDatasetsPage";
import { ModelRunEditorPage } from "./ModelRunEditorPage";
import { labModelVersions } from "./lab-models";
import { buildTrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { useErrorToast } from "../../app/AppToastContext";
import {
  labWorkproductProgression,
} from "./lab-workproduct-progression";
import {
  creationObjective,
  finishModelCreation,
  ModelsTable,
  Pagination,
  SuggestionsTab,
  trainingModelRunSyncKey,
  WorkproductsTable,
} from "./LabsRouteSections";

const PAGE_SIZE = 10;
type SuggestionsView = "observations" | "suggestions";

export type LabsRouteProps = {
  closeDetailKind: LabDetailKind | null;
  closeDetailRequestId: number;
  openSuggestionsRequestId: number;
  onNewModel: (initialTasksetId?: string) => void;
  onUseAgent: (actionId: string, agentName: string) => void;
  onCreateAgent: (
    objective: string,
    authoringRunId?: string | null,
    authoringModel?: ChatModelRef | null,
  ) => Promise<CreateImproveRun>;
  onImproveAgent: (
    agentId: string,
    objective: string,
    agentName?: string | null,
    authoringRunId?: string | null,
    authoringModel?: ChatModelRef | null,
  ) => Promise<CreateImproveRun>;
  onOpenRunConversation: (conversationId: string) => void;
  onDetailOpenChange: (location: LabDetailLocation | null) => void;
  onSkillSelectionChange: (selection: LabSkillSourceSelection | null) => void;
  profileView: ProfileViewProps;
  insights: InsightsViewProps;
  training: Omit<TrainingViewProps, "section" | "onSectionChange">;
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
  insights,
  onAnswerQuestion,
  onApplyCandidate,
  onApprove,
  onCancel,
  candidateReview,
  onCandidateReviewChange,
  onCreateAgent,
  onDetailOpenChange,
  onSkillSelectionChange,
  onImproveAgent,
  onNewModel,
  onOpenPullRequest,
  onOpenCandidateFiles,
  onOpenRunConversation,
  onPause,
  onReconcilePullRequest,
  onRejectCandidate,
  onResume,
  onRevise,
  onUseAgent,
  openSuggestionsRequestId,
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
  const [activeTab, setActiveTab] = useState<LabPrimaryTab>("workproducts");
  const [suggestionsView, setSuggestionsView] =
    useState<SuggestionsView>("observations");
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(
    null,
  );
  const [agentCreateOpen, setAgentCreateOpen] = useState(false);
  const [datasetCreateRoute, setDatasetCreateRoute] = useState<
    "source" | DatasetCreateSource | null
  >(null);
  const [datasetBuildTargetId, setDatasetBuildTargetId] = useState<string | null>(null);
  const [agentRename, setAgentRename] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [resumedModelCreation, setResumedModelCreation] =
    useState<TaskCreationSnapshot | null>(null);
  const [modelEditorSection, setModelEditorSection] = useState<"run" | "dataset">("run");
  const [modelEditorName, setModelEditorName] = useState<string | null>(null);
  const [modelUseVersionId, setModelUseVersionId] = useState<string | null>(
    null
  );
  const [agentImprove, setAgentImprove] = useState<{
    agentId: string;
    agentName: string;
    initialObjective: string;
  } | null>(null);

  const workproducts = useMemo(
    () =>
      labWorkproductProjection({
        profile,
        training: training.training.payload,
        runs: createImprove.runs,
      }),
    [createImprove.runs, profile, training.training.payload]
  );
  const progressionByKey = useMemo(() => {
    const tasksets = new Map(
      (training.training.payload?.tasksets ?? []).map(
        (taskset) => [taskset.id, taskset] as const
      )
    );
    return new Map(
      workproducts.map(
        (workproduct) =>
          [
            workproduct.key,
            labWorkproductProgression({
              workproduct,
              runs: runsForWorkproduct(workproduct, createImprove.runs),
              taskset: workproduct.tasksetId
                ? tasksets.get(workproduct.tasksetId) ?? null
                : null,
              training: training.training.payload,
            }),
          ] as const
      )
    );
  }, [createImprove.runs, training.training.payload, workproducts]);
  const homeWorkproducts = useMemo(
    () => workproducts.filter((workproduct) => workproduct.kind !== "model"),
    [workproducts],
  );
  const homeModels = useMemo(
    () => workproducts.filter((workproduct) => workproduct.kind === "model"),
    [workproducts],
  );
  const selected =
    workproducts.find((workproduct) => workproduct.key === selectedKey) ?? null;
  const selectedSkillSource = useMemo(
    () => labSkillSourceSelection(selected),
    [selected],
  );
  const suggestionCount =
    insights.items.filter((item) => item.status === "active").length +
    (training.training.payload?.candidates.length ?? 0);

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
    if (openSuggestionsRequestId <= 0) return;
    setSuggestionsView("observations");
    setActiveTab("suggestions");
  }, [openSuggestionsRequestId]);
  useEffect(() => {
    if (
      selectedKey &&
      !workproducts.some((workproduct) => workproduct.key === selectedKey)
    ) {
      setSelectedKey(null);
    }
  }, [selectedKey, workproducts]);
  useEffect(() => {
    onSkillSelectionChange(selectedSkillSource);
  }, [onSkillSelectionChange, selectedSkillSource]);
  useEffect(() => {
    if (closeDetailRequestId <= 0) return;
    setSelectedKey(null);
    if (closeDetailKind === "dataset") {
      setSelectedDatasetId(null);
      setActiveTab("datasets");
      return;
    }
    setActiveTab("workproducts");
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
           ...(modelEditorSection === "dataset" ? [{ label: "New Dataset" }] : []),
         ],
      });
      return;
    }
    if (activeTab === "datasets") {
      onDetailOpenChange(
        selectedDatasetId
          ? {
              kind: "dataset",
              kindLabel: "Datasets",
              workproductLabel:
                training.training.payload?.tasksets.find(
                  (taskset) => taskset.id === selectedDatasetId,
                )?.name ?? "Dataset",
              segments: [],
            }
          : null,
      );
      return;
    }
    if (activeTab !== "workproducts") {
      onDetailOpenChange(null);
      return;
    }
    if (!selected) onDetailOpenChange(null);
  }, [
    activeTab,
    onDetailOpenChange,
    selected,
    selectedDatasetId,
    modelEditorSection,
    modelEditorName,
    training.launchRequest,
    training.training.payload?.tasksets,
  ]);
  useEffect(() => () => onDetailOpenChange(null), [onDetailOpenChange]);

  function changePrimaryTab(tab: LabPrimaryTab) {
    setSelectedKey(null);
    setPage(1);
    setSelectedDatasetId(null);
    setActiveTab(tab);
  }

  function openAgentChange(agentId: string, prompt = "") {
    const agent = workproducts.find(
      (workproduct) =>
        workproduct.kind === "agent" && workproduct.id === agentId
    );
    setAgentImprove({
      agentId,
      agentName: agent?.name ?? agentId,
      initialObjective: prompt.trim(),
    });
  }

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
    const job = training.training.payload?.jobs.find(
      (candidate) => candidate.id === version.lineage.jobId
    );
    if (job?.destinationId === "fireworks") {
      setModelUseVersionId(version.lineage.id);
      return;
    }
    training.onChatWithModel(
      buildTrainingModelChatHandoff({
        modelId: version.lineage.id,
        taskset: version.taskset,
      })
    );
  }

  function openDatasetCreation() {
    setDatasetBuildTargetId(null);
    setDatasetCreateRoute("source");
    setSelectedDatasetId(null);
    setActiveTab("datasets");
  }

  function closeDatasetCreation() {
    setDatasetCreateRoute(null);
    setDatasetBuildTargetId(null);
  }

  function openDatasetBuild(tasksetId: string) {
    setDatasetBuildTargetId(tasksetId);
    setDatasetCreateRoute("build");
    setSelectedDatasetId(tasksetId);
    setActiveTab("datasets");
  }

  function finishDatasetCreation(tasksetId: string | null) {
    setDatasetCreateRoute(null);
    setDatasetBuildTargetId(null);
    setSelectedKey(null);
    setActiveTab("datasets");
    setSelectedDatasetId(tasksetId);
  }

  function openModelRunEditor(initialTasksetId?: string) {
    setModelEditorSection("run");
    setSelectedKey(null);
    setSelectedDatasetId(null);
    setActiveTab("workproducts");
    onNewModel(initialTasksetId);
  }
  const closeSelectedWorkproduct = useCallback(() => setSelectedKey(null), []);

  return (
    <LabsView
      activeTab={activeTab}
      showHeader={!training.launchRequest && !selected && !selectedDatasetId && datasetCreateRoute !== "build"}
      suggestionCount={suggestionCount}
      onTabChange={changePrimaryTab}
      onCreateAgent={() => setAgentCreateOpen(true)}
      onCreateDataset={openDatasetCreation}
      onCreateModel={() => openModelRunEditor()}
    >
      {activeTab === "suggestions" ? (
        <SuggestionsTab
          insights={insights}
          suggestionsView={suggestionsView}
          training={training}
          onSuggestionsViewChange={setSuggestionsView}
          onPlanStarted={() => setActiveTab("workproducts")}
        />
      ) : activeTab === "datasets" ? (
        <LabDatasetsPage
          building={datasetCreateRoute === "build"}
          buildContent={datasetCreateRoute === "build" ? (
            <DatasetBuildEditor
              key={datasetBuildTargetId ?? "new-dataset"}
              taskset={training.training.payload?.tasksets.find(
                (candidate) => candidate.id === datasetBuildTargetId,
              ) ?? null}
              createImproveRefresh={createImprove.refresh}
              defaultModel={training.defaultModel}
              localProjects={training.localProjects ?? []}
              onBack={() => {
                if (datasetBuildTargetId) {
                  closeDatasetCreation();
                  return;
                }
                setDatasetCreateRoute("source");
              }}
              onClose={closeDatasetCreation}
              onCreated={finishDatasetCreation}
              onOpenComputeSettings={training.onOpenComputeSettings}
              preferences={training.preferences}
              providerSettings={training.providerSettings}
              reasoningEffort={training.reasoningEffort}
              sessions={training.sessions}
              sources={training.training.payload?.sources ?? []}
              training={training.training}
            />
          ) : null}
          runs={createImprove.runs}
          selectedId={selectedDatasetId}
          state={training.training.payload}
          training={training.training}
          onToast={(message, tone) =>
            profileView.onToast?.(message, tone) ?? 0
          }
          onSelectedIdChange={setSelectedDatasetId}
          onBuild={openDatasetBuild}
          onTrainModel={openModelRunEditor}
          onOpenFiles={(tasksetId) => {
            training.onSelectedTasksetIdChange(tasksetId);
            training.onOpenTasksetFiles();
          }}
        />
      ) : training.launchRequest && training.training.payload ? (
        <ModelRunEditorPage
          connection={profileView.connection}
          initialObjective={training.launchRequest.objective}
          initialTasksetId={training.launchRequest.initialTasksetId}
          profileId={profileId}
          training={training.training}
          onCancel={() => {
            training.onLaunchHandled(training.launchRequest!.id);
          }}
          onFinished={async (modelId, tasksetId) => {
            training.onSelectedTasksetIdChange(tasksetId);
            training.onDetailTasksetIdChange(tasksetId);
            training.onLaunchHandled(training.launchRequest!.id);
            setSelectedKey(workproductKey("model", modelId));
            setActiveTab("workproducts");
            await createImprove.refresh();
          }}
          onNameChange={setModelEditorName}
          onSectionChange={setModelEditorSection}
          onSaved={async (modelId) => {
            training.onLaunchHandled(training.launchRequest!.id);
            setSelectedKey(workproductKey("model", modelId));
            setActiveTab("workproducts");
          }}
          onOpenProviderSettings={training.onOpenProviderSettings}
          renderDatasetBuilder={(onCreated, onUseExistingDataset, buildIntent) => (
            <DatasetBuildEditor
              initialBuildIntent={buildIntent}
              taskset={null}
              createImproveRefresh={createImprove.refresh}
              defaultModel={training.defaultModel}
              localProjects={training.localProjects ?? []}
              onBack={() => undefined}
              onClose={() => undefined}
              onCreated={(tasksetId) => {
                if (tasksetId) onCreated(tasksetId);
              }}
              onOpenComputeSettings={training.onOpenComputeSettings}
              onUseExistingDataset={onUseExistingDataset}
              preferences={training.preferences}
              providerSettings={training.providerSettings}
              reasoningEffort={training.reasoningEffort}
              sessions={training.sessions}
              sources={training.training.payload?.sources ?? []}
              training={training.training}
            />
          )}
        />
      ) : selected ? (
        <LabWorkproductDetail
          connection={profileView.connection}
          profile={profile}
          runs={createImprove.runs}
          training={training.training}
          workproduct={selected}
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
          onRenameAgent={() =>
            setAgentRename({ id: selected.id, name: selected.name })
          }
          onOpenDataset={(tasksetId) => {
            setSelectedKey(null);
            setSelectedDatasetId(tasksetId);
            setActiveTab("datasets");
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
              renderDatasetBuilder={(onCreated, onUseExistingDataset, buildIntent) => (
                <DatasetBuildEditor
                  initialBuildIntent={buildIntent}
                  taskset={null}
                  createImproveRefresh={createImprove.refresh}
                  defaultModel={training.defaultModel}
                  localProjects={training.localProjects ?? []}
                  onBack={() => undefined}
                  onClose={() => undefined}
                  onCreated={(tasksetId) => {
                    if (tasksetId) onCreated(tasksetId);
                  }}
                  onOpenComputeSettings={training.onOpenComputeSettings}
                  onUseExistingDataset={onUseExistingDataset}
                  preferences={training.preferences}
                  providerSettings={training.providerSettings}
                  reasoningEffort={training.reasoningEffort}
                  sessions={training.sessions}
                  sources={training.training.payload?.sources ?? []}
                  training={training.training}
                />
              )}
            />
          )}
          onStartAgentChange={(agentId, prompt) =>
            openAgentChange(agentId, prompt ?? "")
          }
          onToast={training.onToast}
        />
      ) : (
        <div className="labs-flat-body">
          {activeTab === "workproducts" ? (
            <div className="labs-home-profile-controls">
              <ProfileView {...profileView} section="controls" />
            </div>
          ) : null}
          <WorkproductsTable
            frontierBaselineRuns={
              training.training.payload?.frontierBaselineRuns ?? []
            }
            loading={createImprove.loading && !workproducts.length}
            items={homeWorkproducts.slice(
              (page - 1) * PAGE_SIZE,
              page * PAGE_SIZE,
            )}
            progressionByKey={progressionByKey}
            showType
            onSelect={setSelectedKey}
            onUseAgent={onUseAgent}
            onUseModel={useModel}
            onUseSkill={(skill) =>
              profileView.onSkillCommand?.(
                `$${skill.name} `,
                skill.skillSource === "codex" ? "codex" : "openpond",
              )
            }
          />
          <Pagination
            page={page}
            total={homeWorkproducts.length}
            onChange={setPage}
          />
          {activeTab === "workproducts" ? (
            <section className="labs-home-models">
              <div className="labs-section-heading">
                <h2>Models</h2>
              </div>
              <ModelsTable
                loading={false}
                items={homeModels.slice(0, 10)}
                runs={createImprove.runs}
                state={training.training.payload}
                onSelect={setSelectedKey}
                onUseModel={useModel}
              />
            </section>
          ) : null}
        </div>
      )}

      {agentCreateOpen ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialObjective={null}
          localProjects={training.localProjects ?? []}
          onClose={() => setAgentCreateOpen(false)}
          onAgentPromptSubmitted={async ({ analysisModel, objective }) => {
            const run = await onCreateAgent(objective, null, analysisModel);
            await createImprove.refresh();
            setActiveTab("workproducts");
            setSelectedKey(workproductKey("agent", run.target.id ?? run.id));
            setAgentCreateOpen(false);
          }}
          onOpenComputeSettings={training.onOpenComputeSettings}
          onTasksetCreated={async (creation) => {
            const objective = creationObjective(
              creation,
              "Create a useful Agent from the approved Taskset."
            );
            const run = await onCreateAgent(
              objective,
              creation.request.createImproveRunId,
              creation.request.analysisModel,
            );
            await createImprove.refresh();
            setActiveTab("workproducts");
            setSelectedKey(workproductKey("agent", run.target.id ?? run.id));
            setAgentCreateOpen(false);
          }}
          preferences={training.preferences}
          providerSettings={training.providerSettings}
          reasoningEffort={training.reasoningEffort}
          sessions={training.sessions}
          sources={training.training.payload?.sources ?? []}
          targetIntent={{ kind: "agent", id: null, displayName: null, operation: "create" }}
          training={training.training}
        />
      ) : null}
      {datasetCreateRoute === "source" ? (
        <DatasetSourcePickerDialog
          onClose={closeDatasetCreation}
          onSelect={setDatasetCreateRoute}
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
      {agentImprove ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialObjective={agentImprove.initialObjective}
          localProjects={training.localProjects ?? []}
          onClose={() => setAgentImprove(null)}
          onAgentPromptSubmitted={async ({ analysisModel, objective }) => {
            await onImproveAgent(
              agentImprove.agentId,
              objective,
              agentImprove.agentName,
              null,
              analysisModel,
            );
            await createImprove.refresh();
            setActiveTab("workproducts");
            setSelectedKey(workproductKey("agent", agentImprove.agentId));
            setAgentImprove(null);
          }}
          onOpenComputeSettings={training.onOpenComputeSettings}
          onTasksetCreated={async (creation) => {
            const objective = creationObjective(
              creation,
              agentImprove.initialObjective
            );
            await onImproveAgent(
              agentImprove.agentId,
              objective,
              agentImprove.agentName,
              creation.request.createImproveRunId,
              creation.request.analysisModel,
            );
            await createImprove.refresh();
            setActiveTab("workproducts");
            setSelectedKey(workproductKey("agent", agentImprove.agentId));
            setAgentImprove(null);
          }}
          preferences={training.preferences}
          providerSettings={training.providerSettings}
          reasoningEffort={training.reasoningEffort}
          sessions={training.sessions}
          sources={training.training.payload?.sources ?? []}
          targetIntent={{
            kind: "agent",
            id: agentImprove.agentId,
            displayName: agentImprove.agentName,
            operation: "improve",
          }}
          training={training.training}
        />
      ) : null}
      {resumedModelCreation ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialCreation={resumedModelCreation}
          initialObjective={resumedModelCreation.request.objective}
          localProjects={training.localProjects ?? []}
          onClose={() => setResumedModelCreation(null)}
          onOpenComputeSettings={training.onOpenComputeSettings}
          onTasksetCreated={async (creation) => {
            await finishModelCreation(
              creation,
              training,
              createImprove.refresh,
              setSelectedKey,
            );
            setActiveTab("workproducts");
            setResumedModelCreation(null);
          }}
          preferences={training.preferences}
          providerSettings={training.providerSettings}
          reasoningEffort={training.reasoningEffort}
          sessions={training.sessions}
          sources={training.training.payload?.sources ?? []}
          targetIntent={resumedModelCreation.request.targetIntent}
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
      {agentRename ? (
        <LabAgentRenameDialog
          agentId={agentRename.id}
          currentName={agentRename.name}
          onClose={() => setAgentRename(null)}
          onRename={async (name) => {
            if (!profileView.connection) {
              throw new Error("Connect OpenPond before renaming an agent.");
            }
            profileView.onError(null);
            await api.profileAgentRename(
              profileView.connection,
              agentRename.id,
              { name }
            );
            profileView.onPayload(await api.bootstrap(profileView.connection));
            profileView.onToast?.(`Renamed agent to ${name}.`, "success");
          }}
        />
      ) : null}
    </LabsView>
  );
}

function DatasetBuildEditor({
  initialBuildIntent = null,
  taskset,
  createImproveRefresh,
  defaultModel,
  localProjects,
  onBack,
  onClose,
  onCreated,
  onOpenComputeSettings,
  onUseExistingDataset,
  preferences,
  providerSettings,
  reasoningEffort,
  sessions,
  sources,
  training,
}: {
  taskset: Taskset | null;
  initialBuildIntent?: import("../training/TrainingGoalCards").DatasetEvidenceIntent | null;
  createImproveRefresh: () => Promise<unknown>;
  defaultModel: ChatModelRef;
  localProjects: NonNullable<TrainingViewProps["localProjects"]>;
  onBack: () => void;
  onClose: () => void;
  onCreated: (tasksetId: string | null) => void;
  onOpenComputeSettings: TrainingViewProps["onOpenComputeSettings"];
  onUseExistingDataset?: () => void;
  preferences: TrainingViewProps["preferences"];
  providerSettings: TrainingViewProps["providerSettings"];
  reasoningEffort: TrainingViewProps["reasoningEffort"];
  sessions: TrainingViewProps["sessions"];
  sources: TrainingSourceRef[];
  training: TrainingViewProps["training"];
}) {
  const initialSessionIds = taskset?.sourceRefs
    .filter(isTrainingSourceRef)
    .map((source) => source.sessionId) ?? [];

  return (
    <CreateImproveAuthoringDialog
      datasetBuildBackLabel={taskset
        ? "Back to Dataset overview"
        : "Back to Dataset sources"}
      datasetBuildMode
      defaultModel={defaultModel}
      initialObjective={taskset?.objective ?? null}
      initialBuildIntent={initialBuildIntent}
      initialSessionIds={initialSessionIds}
      localProjects={localProjects}
      onBackToDatasetSources={onBack}
      onClose={onClose}
      onOpenComputeSettings={onOpenComputeSettings}
      onUseExistingDataset={onUseExistingDataset}
      onTasksetCreated={async (creation) => {
        await Promise.all([training.refresh(), createImproveRefresh()]);
        onCreated(creation.materializedTasksetId);
      }}
      preferences={preferences}
      presentation="embedded"
      providerSettings={providerSettings}
      reasoningEffort={reasoningEffort}
      resourceIntent="dataset"
      sessions={sessions}
      sources={sources}
      targetIntent={{
        kind: null,
        id: taskset?.id ?? null,
        displayName: taskset?.name ?? null,
        operation: taskset ? "improve" : "create",
      }}
      training={training}
    />
  );
}
