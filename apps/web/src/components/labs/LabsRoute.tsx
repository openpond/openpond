import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ChatModelRef,
  type CreateImproveCandidate,
  type CreateImproveRun,
  type TaskCreationSnapshot,
  type WorkspaceDiffSummary,
} from "@openpond/contracts";

import type { ProfileViewProps } from "../profile/ProfileView";
import { ProfileView } from "../profile/ProfileView";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
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
import { LabModelsPage } from "./LabModelsPage";
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
  Pagination,
  SuggestionsTab,
  trainingModelRunSyncKey,
  WorkproductsTable,
} from "./LabsRouteSections";

const PAGE_SIZE = 10;
export type LabsRouteProps = {
  closeDetailKind: LabDetailKind | null;
  closeDetailRequestId: number;
  onNewModel: (initialTasksetId?: string) => void;
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
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(
    null,
  );
  const [agentCreateOpen, setAgentCreateOpen] = useState(false);
  const [datasetCreateRoute, setDatasetCreateRoute] = useState<
    "source" | DatasetCreateSource | null
  >(null);
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
  const models = useMemo(
    () => workproducts.filter((workproduct) => workproduct.kind === "model"),
    [workproducts],
  );
  const selected =
    workproducts.find((workproduct) => workproduct.key === selectedKey) ?? null;
  const selectedSkillSource = useMemo(
    () => labSkillSourceSelection(selected),
    [selected],
  );
  const suggestionCount = training.training.payload?.candidates.length ?? 0;

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
      setActiveTab("tasksets");
      return;
    }
    setActiveTab(closeDetailKind === "model" ? "models" : "workproducts");
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
        selectedDatasetId
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
    if (activeTab !== "workproducts" && activeTab !== "models") {
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
    training.training.payload?.modelTasksets,
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
    setDatasetCreateRoute("source");
    setSelectedDatasetId(null);
    setActiveTab("tasksets");
  }

  function closeDatasetCreation() {
    setDatasetCreateRoute(null);
  }

  function openDatasetBuilderChat(taskset?: {
    id: string;
    name: string;
    objective: string;
  } | null, buildIntent?: string | null) {
    const target = taskset
      ? `Help me improve the ${taskset.name} Taskset.`
      : buildIntent
        ? `Help me create a Taskset from ${buildIntent.replaceAll("_", " ")} evidence.`
        : "Help me create a Taskset.";
    profileView.onSkillCommand?.(
      `$openpond-taskset-authoring ${target}`,
      "openpond",
    );
    closeDatasetCreation();
  }

  function finishDatasetCreation(tasksetId: string | null) {
    setDatasetCreateRoute(null);
    setSelectedKey(null);
    setActiveTab("tasksets");
    setSelectedDatasetId(tasksetId);
  }

  function openModelRunEditor(initialTasksetId?: string) {
    setModelEditorSection("run");
    setSelectedKey(null);
    setSelectedDatasetId(null);
    setActiveTab("models");
    onNewModel(initialTasksetId);
  }
  const closeSelectedWorkproduct = useCallback(() => setSelectedKey(null), []);

  return (
    <LabsView
      activeTab={activeTab}
      showHeader={!training.launchRequest && !selected && !selectedDatasetId}
      suggestionCount={suggestionCount}
      onTabChange={changePrimaryTab}
      onCreateAgent={() => setAgentCreateOpen(true)}
      onCreateDataset={openDatasetCreation}
      onCreateModel={() => openModelRunEditor()}
    >
      {activeTab === "suggestions" ? (
        <SuggestionsTab
          training={training}
          onPlanStarted={() => setActiveTab("workproducts")}
        />
      ) : activeTab === "tasksets" ? (
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
          onImproveInChat={(taskset) => openDatasetBuilderChat(taskset)}
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
            setActiveTab("models");
            await createImprove.refresh();
          }}
          onNameChange={setModelEditorName}
          onSectionChange={setModelEditorSection}
          onSaved={async (modelId) => {
            training.onLaunchHandled(training.launchRequest!.id);
            setSelectedKey(workproductKey("model", modelId));
            setActiveTab("models");
          }}
          onOpenProviderSettings={training.onOpenProviderSettings}
          renderDatasetBuilder={(_onCreated, onUseExistingDataset, buildIntent) => (
            <DatasetBuilderChatHandoff
              onOpenChat={() => openDatasetBuilderChat(null, buildIntent)}
              onUseExistingDataset={onUseExistingDataset}
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
              renderDatasetBuilder={(_onCreated, onUseExistingDataset, buildIntent) => (
                <DatasetBuilderChatHandoff
                  onOpenChat={() => openDatasetBuilderChat(null, buildIntent)}
                  onUseExistingDataset={onUseExistingDataset}
                />
              )}
            />
          )}
          onStartAgentChange={(agentId, prompt) =>
            openAgentChange(agentId, prompt ?? "")
          }
          onToast={training.onToast}
        />
      ) : activeTab === "models" ? (
        <LabModelsPage
          activeProfileId={profileId}
          items={models}
          loading={training.training.loading && !models.length}
          runs={createImprove.runs}
          state={training.training.payload}
          onSelect={setSelectedKey}
          onUseModel={useModel}
        />
      ) : (
        <div className="labs-flat-body">
          {activeTab === "workproducts" ? (
            <div className="labs-home-profile-controls">
              <ProfileView {...profileView} section="controls" />
            </div>
          ) : null}
          <WorkproductsTable
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
        </div>
      )}

      {agentCreateOpen ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialObjective={null}
          localProjects={training.localProjects ?? []}
          onClose={() => setAgentCreateOpen(false)}
          onAgentPromptSubmitted={async ({ analysisModel, objective }) => {
            await onCreateAgent(objective, null, analysisModel);
            setAgentCreateOpen(false);
          }}
          onOpenComputeSettings={training.onOpenComputeSettings}
          onTasksetCreated={async (creation) => {
            const objective = creationObjective(
              creation,
              "Create a useful Agent from the approved Taskset."
            );
            await onCreateAgent(
              objective,
              creation.request.createImproveRunId,
              creation.request.analysisModel,
            );
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
          onSelect={(source) => {
            if (source === "build") {
              openDatasetBuilderChat();
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
            setActiveTab("models");
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

function DatasetBuilderChatHandoff({
  onOpenChat,
  onUseExistingDataset,
}: {
  onOpenChat: () => void;
  onUseExistingDataset?: () => void;
}) {
  return (
    <section className="training-run-placeholder">
      <h3>Build the Taskset in full Chat</h3>
      <p>
        The Taskset authoring Skill gathers tasks and data conversationally,
        then uses typed actions to materialize graders, evaluations, and the
        executable Taskset. No training starts from this flow.
      </p>
      <div className="labs-dataset-detail-actions">
        <button className="training-button" type="button" onClick={onOpenChat}>
          Open Taskset Builder
        </button>
        {onUseExistingDataset ? (
          <button
            className="training-button secondary"
            type="button"
            onClick={onUseExistingDataset}
          >
            Use existing Taskset
          </button>
        ) : null}
      </div>
    </section>
  );
}
