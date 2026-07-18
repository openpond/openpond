import { useEffect, useMemo, useState } from "react";
import type {
  CreateImproveCandidate,
  CreateImproveRun,
  CrossSystemFrontierBaselineRun,
  TaskCreationSnapshot,
  TrainingStateResponse,
  WorkspaceDiffSummary,
} from "@openpond/contracts";

import type { InsightsViewProps } from "../insights/InsightsView";
import { InsightsView } from "../insights/InsightsView";
import type { ProfileViewProps } from "../profile/ProfileView";
import { ProfileView } from "../profile/ProfileView";
import type { TrainingViewProps } from "../training/TrainingView";
import { CreateImproveAuthoringDialog } from "../create-improve/CreateImproveAuthoringDialog";
import { TrainingSuggestions } from "../training/TrainingSuggestions";
import { ModelUseDialog } from "../training/ModelUseDialog";
import {
  ChartColumnStacked,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Loader2,
  XCircle,
} from "../icons";
import { api } from "../../api";
import { useCreateImproveRuns } from "../../hooks/useCreateImproveRuns";
import {
  trainingMethodLabel,
} from "../training/training-model-data";
import { LabWorkproductDetail } from "./LabWorkproductDetail";
import {
  labWorkproductProjection,
  runsForWorkproduct,
  workproductKey,
  type LabWorkproductSummary,
} from "./lab-workproducts";
import type {
  LabDetailKind,
  LabDetailLocation,
} from "./lab-detail-navigation";
import { LabsView, type LabPrimaryTab } from "./LabsView";
import { LabStatusBadge } from "./LabStatusBadge";
import { LabModelBaselineProgress } from "./LabModelBaseline";
import { LabAgentRenameDialog } from "./LabAgentRenameDialog";
import { LabDatasetsPage } from "./LabDatasetsPage";
import { labModelVersions } from "./lab-models";
import { buildTrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import {
  labWorkproductProgression,
  type LabWorkproductProgression,
} from "./lab-workproduct-progression";

const PAGE_SIZE = 10;
const EMPTY_TIMESTAMP = new Date(0).toISOString();
type SuggestionsView = "observations" | "suggestions";

export type LabsRouteProps = {
  closeDetailKind: LabDetailKind | null;
  closeDetailRequestId: number;
  openSuggestionsRequestId: number;
  onNewModel: () => void;
  onUseAgent: (actionId: string) => void;
  onCreateAgent: (
    objective: string,
    authoringRunId?: string | null
  ) => Promise<CreateImproveRun>;
  onImproveAgent: (
    agentId: string,
    objective: string,
    agentName?: string | null,
    authoringRunId?: string | null
  ) => Promise<CreateImproveRun>;
  onOpenRunConversation: (conversationId: string) => void;
  onDetailOpenChange: (location: LabDetailLocation | null) => void;
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
  const modelRunSyncKey = useMemo(
    () => trainingModelRunSyncKey(training.training.payload),
    [training.training.payload]
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
  const [datasetCreateOpen, setDatasetCreateOpen] = useState(false);
  const [agentRename, setAgentRename] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [resumedModelCreation, setResumedModelCreation] =
    useState<TaskCreationSnapshot | null>(null);
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
  const suggestionCount =
    insights.items.filter((item) => item.status === "active").length +
    (training.training.payload?.candidates.length ?? 0);

  useEffect(() => {
    if (!modelRunSyncKey) return;
    void createImprove.refresh();
  }, [createImprove.refresh, modelRunSyncKey]);
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
              sectionLabels: [],
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

  return (
    <LabsView
      activeTab={activeTab}
      showHeader={!selected && !selectedDatasetId}
      suggestionCount={suggestionCount}
      onTabChange={changePrimaryTab}
      onCreateAgent={() => setAgentCreateOpen(true)}
      onCreateDataset={() => setDatasetCreateOpen(true)}
      onCreateModel={onNewModel}
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
          runs={createImprove.runs}
          selectedId={selectedDatasetId}
          state={training.training.payload}
          onSelectedIdChange={setSelectedDatasetId}
          onCreate={() => setDatasetCreateOpen(true)}
          onOpenFiles={(tasksetId) => {
            training.onSelectedTasksetIdChange(tasksetId);
            training.onOpenTasksetFiles();
          }}
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
          onStartAgentChange={(agentId, prompt) =>
            openAgentChange(agentId, prompt ?? "")
          }
          onToast={training.onToast}
        />
      ) : (
        <div className="labs-flat-body">
          {createImprove.error ? (
            <div className="training-banner error">{createImprove.error}</div>
          ) : null}
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
            onUseSkill={(skillName) =>
              profileView.onSkillCommand?.(`$${skillName} `)
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

      {training.launchRequest && training.training.payload ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialObjective={training.launchRequest.objective}
          initialSessionIds={training.launchRequest.initialSessionIds ?? []}
          localProjects={training.localProjects ?? []}
          onClose={() => training.onLaunchHandled(training.launchRequest!.id)}
          onModelCreatedFromTaskset={async (taskset, run) => {
            training.onLaunchHandled(training.launchRequest!.id);
            training.onSelectedTasksetIdChange(taskset.id);
            training.onDetailTasksetIdChange(taskset.id);
            setSelectedKey(
              workproductKey("model", run.target.id ?? run.id),
            );
            setActiveTab("workproducts");
            await createImprove.refresh();
          }}
          onTasksetCreated={async (creation) => {
            await finishModelCreation(
              creation,
              training,
              createImprove.refresh,
              setSelectedKey,
            );
            setActiveTab("workproducts");
          }}
          preferences={training.preferences}
          providerSettings={training.providerSettings}
          reasoningEffort={training.reasoningEffort}
          sessions={training.sessions}
          sources={training.training.payload.sources}
          training={training.training}
        />
      ) : null}
      {agentCreateOpen ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialObjective={null}
          localProjects={training.localProjects ?? []}
          onClose={() => setAgentCreateOpen(false)}
          onTasksetCreated={async (creation) => {
            const objective = creationObjective(
              creation,
              "Create a useful Agent from the approved Taskset."
            );
            const run = await onCreateAgent(
              objective,
              creation.request.createImproveRunId
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
      {datasetCreateOpen ? (
        <CreateImproveAuthoringDialog
          defaultModel={training.defaultModel}
          initialObjective={null}
          localProjects={training.localProjects ?? []}
          onClose={() => setDatasetCreateOpen(false)}
          onTasksetCreated={async (creation) => {
            setDatasetCreateOpen(false);
            setSelectedKey(null);
            setActiveTab("datasets");
            setSelectedDatasetId(creation.materializedTasksetId);
            await createImprove.refresh();
          }}
          preferences={training.preferences}
          providerSettings={training.providerSettings}
          reasoningEffort={training.reasoningEffort}
          resourceIntent="dataset"
          sessions={training.sessions}
          sources={training.training.payload?.sources ?? []}
          targetIntent={{
            kind: null,
            id: null,
            displayName: null,
            operation: "create",
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
          onTasksetCreated={async (creation) => {
            const objective = creationObjective(
              creation,
              agentImprove.initialObjective
            );
            await onImproveAgent(
              agentImprove.agentId,
              objective,
              agentImprove.agentName,
              creation.request.createImproveRunId
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

function SuggestionsTab({
  insights,
  suggestionsView,
  training,
  onSuggestionsViewChange,
  onPlanStarted,
}: {
  insights: InsightsViewProps;
  suggestionsView: SuggestionsView;
  training: LabsRouteProps["training"];
  onSuggestionsViewChange: (view: SuggestionsView) => void;
  onPlanStarted: () => void;
}) {
  return (
    <section className="labs-suggestions-page" aria-label="Suggestions">
      <div
        className="labs-subtabs"
        role="tablist"
        aria-label="Suggestion types"
      >
        <button
          aria-selected={suggestionsView === "observations"}
          className={suggestionsView === "observations" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => onSuggestionsViewChange("observations")}
        >
          Observations{" "}
          <span>
            {insights.items.filter((item) => item.status === "active").length}
          </span>
        </button>
        <button
          aria-selected={suggestionsView === "suggestions"}
          className={suggestionsView === "suggestions" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => onSuggestionsViewChange("suggestions")}
        >
          AI suggestions{" "}
          <span>{training.training.payload?.candidates.length ?? 0}</span>
        </button>
      </div>
      <div className="labs-suggestions-body">
        {suggestionsView === "observations" ? (
          <InsightsView {...insights} />
        ) : (
          <TrainingSuggestions
            training={training.training}
            defaultModel={training.defaultModel}
            preferences={training.preferences}
            reasoningEffort={training.reasoningEffort}
            onPlanStarted={onPlanStarted}
          />
        )}
      </div>
    </section>
  );
}

function WorkproductsTable({
  frontierBaselineRuns,
  items,
  loading,
  progressionByKey,
  showType,
  onSelect,
  onUseAgent,
  onUseModel,
  onUseSkill,
}: {
  frontierBaselineRuns: CrossSystemFrontierBaselineRun[];
  items: LabWorkproductSummary[];
  loading: boolean;
  progressionByKey: Map<string, LabWorkproductProgression>;
  showType: boolean;
  onSelect: (key: string) => void;
  onUseAgent: (actionId: string) => void;
  onUseModel: (tasksetId: string) => void;
  onUseSkill: (skillName: string) => void;
}) {
  if (loading)
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading workproducts…
      </div>
    );
  if (!items.length)
    return (
      <div className="labs-table-empty">No workproducts match this view.</div>
    );
  const frontierBaselineById = new Map(
    frontierBaselineRuns.map((run) => [run.id, run] as const)
  );
  return (
    <div className="training-table-wrap">
      <table
        className={`training-data-table labs-workproducts-table${
          showType ? "" : " models-only"
        }`}
      >
        <thead>
          <tr>
            {showType ? <th>Type</th> : null}
            <th>Name</th>
            <th>Status</th>
            <th>Training</th>
            <th>Evals</th>
            <th>Updated</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const progression = progressionByKey.get(item.key);
            const frontierBaseline = item.frontierBaselineRunId
              ? frontierBaselineById.get(item.frontierBaselineRunId) ?? null
              : null;
            return (
              <tr key={item.key} onClick={() => onSelect(item.key)}>
                {showType ? (
                  <td className="labs-workproduct-type">
                    {titleCase(item.kind)}
                  </td>
                ) : null}
                <td>
                  <button
                    className={frontierBaseline
                      ? "labs-workproduct-link labs-training-run-name"
                      : "labs-workproduct-link"}
                    type="button"
                    onClick={() => onSelect(item.key)}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                    {frontierBaseline ? (
                      <LabModelBaselineProgress
                        run={frontierBaseline}
                        showOutcomes={false}
                      />
                    ) : null}
                  </button>
                </td>
                <td>
                  <LabStatusBadge
                    label={progression?.statusLabel ?? item.status}
                    value={progression?.statusValue ?? item.status}
                  />
                </td>
                <td className="labs-workproduct-training">
                  {workproductTraining(item)}
                </td>
                <td className="labs-workproduct-evals">
                  {workproductEvals(item)}
                </td>
                <td className="labs-workproduct-updated">
                  {item.updatedAt === EMPTY_TIMESTAMP
                    ? "—"
                    : compactUpdatedAt(item.updatedAt)}
                </td>
                <td>
                  <div className="labs-workproduct-actions">
                    {item.kind === "skill" ? (
                      <button
                        className="settings-secondary compact labs-workproduct-use"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseSkill(item.name);
                        }}
                      >
                        Use
                      </button>
                    ) : item.kind === "agent" && item.useActionId ? (
                      <button
                        className="settings-secondary compact labs-workproduct-use"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseAgent(item.useActionId!);
                        }}
                      >
                        Use
                      </button>
                    ) : item.kind === "model" && item.enabled !== null ? (
                      <button
                        className="settings-secondary compact labs-workproduct-use"
                        type="button"
                        disabled={!item.enabled}
                        title={item.enabled
                          ? "Start a bounded chat session with this model"
                          : "Chat is available after a version passes frozen evaluation"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseModel(item.id);
                        }}
                      >
                        Chat
                      </button>
                    ) : null}
                    <ChevronRight size={15} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModelsTable({
  items,
  loading,
  runs,
  state,
  onSelect,
  onUseModel,
}: {
  items: LabWorkproductSummary[];
  loading: boolean;
  runs: CreateImproveRun[];
  state: TrainingStateResponse | null;
  onSelect: (key: string) => void;
  onUseModel: (modelId: string) => void;
}) {
  if (loading) {
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading Models…
      </div>
    );
  }
  if (!items.length) {
    return <div className="labs-table-empty">No Models yet.</div>;
  }
  return (
    <div className="training-table-wrap">
      <table className="training-data-table labs-models-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Active</th>
            <th>Eval</th>
            <th>Versions</th>
            <th>Updated</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const versions = labModelVersions(item, runs, state);
            const current =
              versions.find((version) => version.current) ?? null;
            const latest = versions[0] ?? null;
            return (
              <tr key={item.key} onClick={() => onSelect(item.key)}>
                <td>
                  <button
                    className="labs-workproduct-link"
                    type="button"
                    onClick={() => onSelect(item.key)}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                  </button>
                </td>
                <td>
                  {current
                    ? `Version ${current.number} · ${trainingMethodLabel(
                        current.plan?.recipe.method,
                      )}`
                    : "Not selected"}
                </td>
                <td>
                  <LabStatusBadge
                    label={
                      latest
                        ? latest.lineage.promotable
                          ? "Passed"
                          : latest.lineage.frozenEvaluationArtifactId
                            ? "Failed"
                            : "Not run"
                        : "Not run"
                    }
                    value={
                      latest?.lineage.promotable
                        ? "passed"
                        : latest?.lineage.frozenEvaluationArtifactId
                          ? "failed"
                          : "not_run"
                    }
                  />
                </td>
                <td>{versions.length}</td>
                <td>{compactUpdatedAt(item.updatedAt)}</td>
                <td>
                  <div className="labs-workproduct-actions">
                    <button
                      className="settings-secondary compact labs-workproduct-use"
                      disabled={!current}
                      title={
                        current
                          ? "Chat with the active Version"
                          : "Set a passing Version active before Chat"
                      }
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onUseModel(item.id);
                      }}
                    >
                      Chat
                    </button>
                    <ChevronRight size={15} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function workproductTraining(item: LabWorkproductSummary) {
  if (item.kind !== "model") {
    return (
      <span className="labs-workproduct-na" title="Training not applicable">
        —
      </span>
    );
  }
  const label = `${item.trainingRunCount} training ${
    item.trainingRunCount === 1 ? "run" : "runs"
  }`;
  return (
    <span
      className={`labs-workproduct-indicator${
        item.trainingRunCount > 0 ? " active" : ""
      }`}
      title={label}
    >
      <ChartColumnStacked aria-hidden="true" size={15} />
      <strong aria-hidden="true">{item.trainingRunCount}</strong>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function workproductEvals(item: LabWorkproductSummary) {
  const presentation =
    item.evaluationStatus === "passed"
      ? {
          icon: <CheckCircle2 aria-hidden="true" size={16} />,
          label: "Evals passed",
          tone: "positive",
        }
      : item.evaluationStatus === "failed"
      ? {
          icon: <XCircle aria-hidden="true" size={16} />,
          label: "Evals failed",
          tone: "negative",
        }
      : {
          icon: <CircleDashed aria-hidden="true" size={16} />,
          label: "Evals not run",
          tone: "neutral",
        };
  return (
    <span
      className={`labs-workproduct-indicator ${presentation.tone}`}
      title={presentation.label}
    >
      {presentation.icon}
      <span className="sr-only">{presentation.label}</span>
    </span>
  );
}

function compactUpdatedAt(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "2-digit" }),
  }).format(date);
}

function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <nav className="labs-pagination" aria-label="Pagination">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </button>
      <span>
        {page} of {pages}
      </span>
      <button
        type="button"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

async function finishModelCreation(
  creation: TaskCreationSnapshot,
  training: LabsRouteProps["training"],
  refreshRuns: () => Promise<CreateImproveRun[] | null>,
  setSelectedKey: (key: string | null) => void
) {
  training.onLaunchHandled(training.launchRequest?.id ?? 0);
  if (!creation.materializedTasksetId) return;
  training.onSelectedTasksetIdChange(creation.materializedTasksetId);
  training.onDetailTasksetIdChange(creation.materializedTasksetId);
  const refreshed = await refreshRuns();
  const run = refreshed?.find(
    (candidate) => candidate.id === creation.request.createImproveRunId,
  );
  setSelectedKey(
    workproductKey(
      "model",
      run?.target.kind === "model"
        ? run.target.id ?? run.id
        : creation.materializedTasksetId,
    ),
  );
}

function creationObjective(
  creation: TaskCreationSnapshot,
  fallback: string
): string {
  return (
    creation.request.objective?.trim() ||
    creation.proposal?.objective.trim() ||
    creation.proposal?.name.trim() ||
    fallback
  );
}

function titleCase(value: string): string {
  return value
    ? `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("_", " ")}`
    : value;
}

function trainingModelRunSyncKey(
  training: TrainingViewProps["training"]["payload"]
): string {
  if (!training) return "";
  return [
    ...training.jobs.map((job) => `job:${job.id}:${job.status}`),
    ...training.models.map(
      (model) =>
        `model:${model.id}:${model.status}:${model.artifactId}:${model.jobId}`
    ),
  ]
    .sort()
    .join("|");
}
