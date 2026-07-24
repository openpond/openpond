import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CreateImproveCandidate,
  CreateImproveRun,
  OpenPondProfileState,
  WorkspaceDiffSummary,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import {
  buildTrainingModelChatHandoff,
  type TrainingModelChatHandoff,
} from "../../lib/training-model-chat-handoff";
import type { CreateImproveReviewActionInput } from "../chat/create-pipeline-types";
import { DetailSection } from "../training/DetailSection";
import { ModelUseDialog } from "../training/ModelUseDialog";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { labWorkproductKindLabel, runsForWorkproduct } from "./lab-workproducts";
import type { LabDetailLocation } from "./lab-detail-navigation";
import { LabAgentEvalActions } from "./LabEvalActions";
import { LabAgentChanges } from "./LabAgentChanges";
import { LabAgentChangeHistory } from "./LabAgentChangeHistory";
import { LabModelVersionDetailPage, LabModelVersionsPage } from "./LabModelWorkspace";
import { LabRunDecisionSection } from "./LabRunDecisionSection";
import { LabStatusBadge } from "./LabStatusBadge";
import { LabStatusDot } from "./LabStatusDot";
import { labModelVersions } from "./lab-models";
import { labWorkproductProgression } from "./lab-workproduct-progression";
import {
  ActivitySection,
  candidateFileScope,
  changeDotTone,
  changeStatusDescription,
  Config,
  detailBreadcrumbs,
  EvalSummary,
  Fact,
  latestReviewableCandidate,
  titleCase,
  VersionSummary,
  WorkproductConfiguration,
} from "./LabWorkproductDetailSections";
import { SquarePen } from "../icons";

type TrainingController = ReturnType<typeof useTraining>;
type WorkproductDetailTab =
  | "overview"
  | "runs"
  | "changes"
  | "evals"
  | "versions"
  | "configuration";

export function LabWorkproductDetail({
  workproduct,
  runs,
  profile,
  training,
  connection,
  onOpenConversation,
  onClose,
  onLocationChange,
  onRenameAgent,
  onStartAgentChange,
  onOpenDataset,
  onToast,
  onAnswerQuestion,
  candidateReview,
  onApprove,
  onCancel,
  onChatWithModel,
  onApplyCandidate,
  onCandidateReviewChange,
  onOpenCandidateFiles,
  onOpenPullRequest,
  onPause,
  onReconcilePullRequest,
  onRejectCandidate,
  onResume,
  onRevise,
  renderModelRunEditor,
}: {
  workproduct: LabWorkproductSummary;
  runs: CreateImproveRun[];
  profile: OpenPondProfileState | null;
  training: TrainingController;
  connection: ClientConnection | null;
  onOpenConversation: (conversationId: string) => void;
  onClose: () => void;
  onLocationChange: (location: LabDetailLocation | null) => void;
  onRenameAgent: () => void;
  onStartAgentChange: (agentId: string, prompt?: string) => void;
  onOpenDataset: (tasksetId: string) => void;
  onToast: ShowAppToast;
  onAnswerQuestion: (
    input: CreateImproveReviewActionInput,
    questionId: string,
    answerValue: string,
  ) => Promise<void>;
  onApprove: (input: CreateImproveReviewActionInput) => Promise<void>;
  onCancel: (input: CreateImproveReviewActionInput) => Promise<void>;
  onChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  onApplyCandidate: (input: CreateImproveReviewActionInput, candidateId: string) => Promise<void>;
  onCandidateReviewChange: (
    input: {
      run: CreateImproveRun;
      candidate: CreateImproveCandidate;
      fileRootPath: string | null;
      initialPath: string | null;
    } | null,
  ) => void;
  onOpenCandidateFiles: () => void;
  onOpenPullRequest: (input: CreateImproveReviewActionInput, candidateId: string) => Promise<void>;
  onPause: (input: CreateImproveReviewActionInput) => Promise<void>;
  onReconcilePullRequest: (
    input: CreateImproveReviewActionInput,
    candidateId: string,
  ) => Promise<void>;
  onRejectCandidate: (input: CreateImproveReviewActionInput, candidateId: string) => Promise<void>;
  onResume: (input: CreateImproveReviewActionInput) => Promise<void>;
  onRevise: (input: CreateImproveReviewActionInput, revision: string) => Promise<void>;
  renderModelRunEditor: (input: {
    initialTasksetId: string | null;
    draftId: string | null;
    modelId: string;
    modelName: string;
    onCancel: () => void;
    onFinished: () => Promise<void>;
    onSectionChange: (section: "run" | "dataset") => void;
  }) => ReactNode;
  candidateReview: {
    diff: WorkspaceDiffSummary | null;
    error: string | null;
    loading: boolean;
  };
}) {
  const workproductRuns = useMemo(() => runsForWorkproduct(workproduct, runs), [runs, workproduct]);
  const [selectedRunId, setSelectedRunId] = useState(workproductRuns[0]?.id ?? "");
  const [selectedChangeRunId, setSelectedChangeRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkproductDetailTab>(
    workproduct.kind === "model" && ["Draft", "Ready to run"].includes(workproduct.status)
      ? "runs"
      : "overview",
  );
  const [editingRunDraftId, setEditingRunDraftId] = useState<string | "new" | null>(null);
  const [editorSection, setEditorSection] = useState<"run" | "dataset">("run");
  const editorExitTargetRef = useRef<"overview" | "runs" | "collection">("runs");
  const [selectedModelEntryKey, setSelectedModelEntryKey] = useState<string | null>(null);
  const [selectedModelRunTab, setSelectedModelRunTab] = useState<
    "summary" | "metrics" | "evals" | "artifacts" | "logs"
  >("summary");
  const [modelUseVersionId, setModelUseVersionId] = useState<string | null>(null);
  const selectedRun =
    workproductRuns.find((run) => run.id === selectedRunId) ?? workproductRuns[0] ?? null;
  const selectedChangeRun = selectedChangeRunId
    ? workproductRuns.find((run) => run.id === selectedChangeRunId) ?? null
    : null;
  const selectedChangeCandidate = selectedChangeRun
    ? latestReviewableCandidate(selectedChangeRun)
    : null;
  const locationKindLabel = labWorkproductKindLabel(workproduct.kind);
  const selectedChangeCommit = selectedChangeCandidate?.git?.headCommit ?? null;
  const locationSegments = useMemo(
    () =>
      workproduct.kind === "model"
        ? editingRunDraftId
          ? [
              {
                label: "Runs",
                onSelect: () => requestEditorExit("runs"),
              },
              { label: editingRunDraftId === "new" ? "New run" : "Resume draft" },
              ...(editorSection === "dataset" ? [{ label: "New Dataset" }] : []),
            ]
          : selectedModelEntryKey
            ? [
                {
                  label: "Runs",
                  onSelect: () => {
                    setSelectedModelEntryKey(null);
                    setActiveTab("runs");
                  },
                },
                { label: "Run details" },
                ...(selectedModelRunTab === "summary"
                  ? []
                  : [{ label: titleCase(selectedModelRunTab) }]),
              ]
            : [{ label: activeTab === "runs" ? "Runs" : titleCase(activeTab) }]
        : detailBreadcrumbs(
            activeTab === "runs" ? "overview" : activeTab,
            selectedChangeRunId,
            selectedChangeCommit,
            workproduct.kind === "agent",
          ).map((label) => ({ label })),
    [
      activeTab,
      editorSection,
      editingRunDraftId,
      selectedChangeCommit,
      selectedChangeRunId,
      selectedModelEntryKey,
      selectedModelRunTab,
      workproduct.kind,
    ],
  );
  const taskset = workproduct.tasksetId
    ? training.payload?.tasksets.find((item) => item.id === workproduct.tasksetId) ?? null
    : null;
  const persistedProfileAgent =
    workproduct.kind === "agent"
      ? profile?.agents.some((agent) => agent.id === workproduct.id) ?? false
      : false;
  const progression = labWorkproductProgression({
    workproduct,
    runs: workproductRuns,
    taskset,
    training: training.payload,
  });
  const preferredRunId = progression.runId ?? workproductRuns[0]?.id ?? "";
  const selectedRunAvailable = workproductRuns.some((run) => run.id === selectedRunId);
  const selectedChangeRunAvailable = selectedChangeRunId
    ? workproductRuns.some((run) => run.id === selectedChangeRunId)
    : true;
  const detailTabs = [
    ["overview", "Overview"],
    ["changes", "Changes"],
    ["evals", "Evals"],
    ["versions", "Versions"],
    ["configuration", "Configuration"],
  ] as const;
  const modelTabs = [
    ["overview", "Overview"],
    ["runs", "Runs"],
    ["configuration", "Configuration"],
  ] as const;

  useEffect(() => {
    onCandidateReviewChange(null);
    setSelectedRunId(preferredRunId);
    setSelectedChangeRunId(null);
    setSelectedModelEntryKey(null);
    setSelectedModelRunTab("summary");
    setActiveTab(
      workproduct.kind === "model" && ["Draft", "Ready to run"].includes(workproduct.status)
        ? "runs"
        : "overview",
    );
    setEditingRunDraftId(null);
    setEditorSection("run");
  }, [workproduct.key]);

  useEffect(() => {
    if (selectedRunId && selectedRunAvailable) return;
    setSelectedRunId(preferredRunId);
  }, [preferredRunId, selectedRunAvailable, selectedRunId]);

  useEffect(() => {
    if (selectedChangeRunAvailable) return;
    setSelectedChangeRunId(null);
  }, [selectedChangeRunAvailable]);

  useEffect(() => {
    if (activeTab === "changes" && selectedChangeRun && selectedChangeCandidate) {
      const scope = candidateFileScope(workproduct, profile, selectedChangeCandidate);
      onCandidateReviewChange({
        run: selectedChangeRun,
        candidate: selectedChangeCandidate,
        fileRootPath: scope.fileRootPath,
        initialPath: scope.initialPath,
      });
      return;
    }
    onCandidateReviewChange(null);
  }, [
    activeTab,
    onCandidateReviewChange,
    profile,
    selectedChangeCandidate,
    selectedChangeRun,
    workproduct,
  ]);

  useEffect(() => {
    onLocationChange({
      kind: workproduct.kind,
      kindLabel: locationKindLabel,
      kindOnSelect:
        workproduct.kind === "model"
          ? () => {
              if (editingRunDraftId) {
                requestEditorExit("collection");
                return;
              }
              onClose();
            }
          : undefined,
      workproductLabel: workproduct.name,
      workproductOnSelect: workproduct.kind === "model"
        ? () => {
            if (editingRunDraftId) {
              requestEditorExit("overview");
              return;
            }
            setEditingRunDraftId(null);
            setSelectedModelEntryKey(null);
            setActiveTab("overview");
          }
        : undefined,
      segments: locationSegments,
    });
  }, [
    locationKindLabel,
    locationSegments,
    onClose,
    onLocationChange,
    workproduct.kind,
    workproduct.name,
  ]);

  useEffect(() => () => onCandidateReviewChange(null), [onCandidateReviewChange]);

  function useModelVersion(versionId: string) {
    const version = labModelVersions(workproduct, runs, training.payload).find(
      (candidate) => candidate.lineage.id === versionId,
    );
    if (!version?.taskset) return;
    if (version.job?.destinationId === "fireworks") {
      setModelUseVersionId(versionId);
      return;
    }
    onChatWithModel(
      buildTrainingModelChatHandoff({
        modelId: versionId,
        taskset: version.taskset,
      }),
    );
  }

  function requestEditorExit(target: "overview" | "runs" | "collection") {
    editorExitTargetRef.current = target;
    document.getElementById("model-run-editor-cancel")?.click();
  }

  if (workproduct.kind === "model" && editingRunDraftId) {
    return renderModelRunEditor({
      initialTasksetId: taskset?.id ?? null,
      draftId: editingRunDraftId === "new" ? null : editingRunDraftId,
      modelId: workproduct.id,
      modelName: workproduct.name,
      onCancel: () => {
        const target = editorExitTargetRef.current;
        setEditingRunDraftId(null);
        setEditorSection("run");
        if (target === "collection") {
          onClose();
          return;
        }
        setActiveTab(target);
      },
      onFinished: async () => {
        setEditingRunDraftId(null);
        setEditorSection("run");
        setActiveTab("runs");
      },
      onSectionChange: setEditorSection,
    });
  }

  return (
    <div className="training-model-detail labs-workproduct-detail">
      <header className="training-model-detail-header labs-workproduct-detail-header">
        <div>
          <div className="labs-workproduct-name-row">
            <h1>{workproduct.name}</h1>
            <LabStatusDot label={progression.statusLabel} value={progression.statusValue} />
          </div>
        </div>
        {workproduct.kind === "model" ? (
          <div className="labs-workproduct-header-actions">
            <button
              className="training-button"
              type="button"
              onClick={() => setEditingRunDraftId("new")}
            >
              New run
            </button>
          </div>
        ) : workproduct.kind === "agent" ? (
          <div className="labs-workproduct-header-actions">
            <button
              className="training-button"
              type="button"
              onClick={() => onStartAgentChange(workproduct.id)}
            >
              Improve agent
            </button>
            {persistedProfileAgent ? (
              <button className="settings-secondary compact" type="button" onClick={onRenameAgent}>
                <SquarePen size={14} />
                <span>Rename</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {selectedModelEntryKey ? null : <div
        className="training-detail-tabs"
        role="tablist"
        aria-label={workproduct.kind === "model" ? "Model detail" : "Workproduct detail"}
      >
        {(workproduct.kind === "model" ? modelTabs : detailTabs).map(([id, label]) => (
          <button
            className={activeTab === id ? "active" : undefined}
            aria-selected={activeTab === id}
            key={id}
            role="tab"
            type="button"
            onClick={() => {
              setActiveTab(id);
              if (workproduct.kind === "model") setSelectedModelEntryKey(null);
              if (id === "changes") setSelectedChangeRunId(null);
            }}
          >
            {label}
            {id === "changes" ? (
              <LabStatusDot
                decorative
                label={changeStatusDescription(workproductRuns[0] ?? null)}
                size="small"
                tone={changeDotTone(workproductRuns[0] ?? null)}
              />
            ) : null}
          </button>
        ))}
      </div>}

      <div className="training-detail-sections">
        {workproduct.kind === "model" && activeTab === "configuration" ? (
          <WorkproductConfiguration workproduct={workproduct} profile={profile} />
        ) : workproduct.kind === "model" && activeTab === "runs" ? (
          selectedModelEntryKey ? (
            <LabModelVersionDetailPage
              connection={connection}
              runs={runs}
              selectedEntryKey={selectedModelEntryKey}
              training={training}
              workproduct={workproduct}
              onBack={() => {
                setSelectedModelEntryKey(null);
                setSelectedModelRunTab("summary");
              }}
              onOpenDataset={onOpenDataset}
              onTabChange={setSelectedModelRunTab}
              onUseVersion={useModelVersion}
            />
          ) : (
            <LabModelVersionsPage
              runs={runs}
              training={training}
              workproduct={workproduct}
              onOpenDataset={onOpenDataset}
              onOpenEntry={setSelectedModelEntryKey}
              onResumeDraft={setEditingRunDraftId}
              onToast={onToast}
            />
          )
        ) : workproduct.kind === "model" ? (
          <DetailSection title="Overview">
            <dl className="labs-inline-facts">
              <Fact label="Status" value={progression.statusLabel} />
              <Fact label="Runs" value={String(workproduct.trainingRunCount)} />
              <Fact
                label="Versions"
                value={String(labModelVersions(workproduct, runs, training.payload).length)}
              />
              <Fact label="Model ID" value={workproduct.id} />
            </dl>
            <p className="labs-detail-copy">{workproduct.description}</p>
          </DetailSection>
        ) : activeTab === "overview" ? (
          <DetailSection title="Overview">
            <dl className="labs-inline-facts">
              <Fact label="Type" value={titleCase(workproduct.kind)} />
              <Fact label="Status" value={progression.statusLabel} />
              {workproduct.kind === "agent" ? (
                <Fact label="Profile" value="Saved in your Profile" />
              ) : (
                <>
                  <Fact label="ID" value={workproduct.id} />
                  <Fact label="Path" value={workproduct.path ?? "Managed artifact"} />
                </>
              )}
            </dl>
            <p className="labs-detail-copy">{workproduct.description}</p>
          </DetailSection>
        ) : activeTab === "changes" && !selectedChangeRun ? (
          <div className="labs-change-index">
            <LabAgentChangeHistory
              runs={workproductRuns}
              onReview={(run) => {
                setSelectedRunId(run.id);
                setSelectedChangeRunId(run.id);
              }}
            />
          </div>
        ) : activeTab === "changes" && selectedChangeRun && selectedChangeCandidate ? (
          <LabAgentChanges
            candidate={selectedChangeCandidate}
            diff={candidateReview.diff}
            error={candidateReview.error}
            run={selectedChangeRun}
            onApplyCandidate={(run, candidateId) => onApplyCandidate({ run }, candidateId)}
            onOpenFiles={onOpenCandidateFiles}
            onRejectCandidate={(run, candidateId) => onRejectCandidate({ run }, candidateId)}
          />
        ) : activeTab === "changes" && selectedChangeRun ? (
          <div className="labs-change-run-detail">
            <article className="labs-change-card">
              <header className="labs-change-card-header">
                <span className="labs-change-timeline-label">Request</span>
                <LabStatusBadge
                  label={selectedChangeRun.state.replaceAll("_", " ")}
                  value={selectedChangeRun.state}
                />
              </header>
              <div className="labs-change-card-body">
                <h3>{selectedChangeRun.objective}</h3>
              </div>
            </article>
            <LabRunDecisionSection
              run={selectedChangeRun}
              onAnswerQuestion={onAnswerQuestion}
              onApplyCandidate={onApplyCandidate}
              onApprove={onApprove}
              onCancel={onCancel}
              onOpenConversation={onOpenConversation}
              onOpenPullRequest={onOpenPullRequest}
              onPause={onPause}
              onReconcilePullRequest={onReconcilePullRequest}
              onRejectCandidate={onRejectCandidate}
              onResume={onResume}
              onRetry={() => onStartAgentChange(workproduct.id, selectedChangeRun.objective)}
              onRevise={onRevise}
            />
          </div>
        ) : activeTab === "evals" ? (
          <DetailSection
            title="Evals"
            actions={
              workproduct.kind === "agent" ? (
                <LabAgentEvalActions
                  agentId={workproduct.id}
                  evals={profile?.evals ?? []}
                  onCreate={() =>
                    onStartAgentChange(
                      workproduct.id,
                      `Create an Eval for ${workproduct.name}. Describe the behavior this Eval should specify: `,
                    )
                  }
                  onAttach={(evalRef) =>
                    onStartAgentChange(
                      workproduct.id,
                      `--eval ${JSON.stringify(evalRef)} Improve ${
                        workproduct.name
                      } using this existing Eval: `,
                    )
                  }
                />
              ) : null
            }
          >
            <EvalSummary
              profileEvals={profile?.evals ?? []}
              run={selectedRun}
              workproduct={workproduct}
            />
          </DetailSection>
        ) : activeTab === "versions" ? (
          <>
            <DetailSection title="Versions">
              <VersionSummary
                runs={workproductRuns}
                selectedRun={selectedRun}
                taskset={taskset}
                training={training}
                trainingState={training.payload}
                onToast={onToast}
              />
            </DetailSection>
            <ActivitySection
              runs={workproductRuns}
              selectedRun={selectedRun}
              onSelectedRunIdChange={setSelectedRunId}
            />
          </>
        ) : (
          <>
            <DetailSection title="Connections">
              <dl className="training-configuration-list">
                <Config label="Profile" value={profile?.activeProfile ?? "default"} />
                <Config
                  label="Conversation"
                  value={selectedRun?.scope.conversationId ?? "Not linked"}
                />
                <Config label="Project" value={selectedRun?.scope.projectId ?? "Not linked"} />
                <Config
                  label="Source authority"
                  value={selectedRun?.adapter.sourceAuthority ?? "Profile"}
                />
              </dl>
            </DetailSection>
            <WorkproductConfiguration workproduct={workproduct} profile={profile} />
          </>
        )}
      </div>

      {modelUseVersionId
        ? (() => {
            const version = labModelVersions(workproduct, runs, training.payload).find(
              (candidate) => candidate.lineage.id === modelUseVersionId,
            );
            if (!version?.taskset) return null;
            return (
              <ModelUseDialog
                lineage={version.lineage}
                taskset={version.taskset}
                training={training}
                onChat={onChatWithModel}
                onClose={() => setModelUseVersionId(null)}
              />
            );
          })()
        : null}
    </div>
  );
}
