import { useEffect, useMemo, useState } from "react";
import type {
  CreateImproveCandidate,
  CreateImproveRun,
  OpenPondProfileEval,
  OpenPondProfileState,
  Taskset,
  TrainingStateResponse,
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
import { TrainingModelPromotion } from "../training/TrainingModelPromotion";
import { TrainingStartDialog } from "../training/TrainingStartDialog";
import {
  formatDateTime,
  trainingMethodLabel,
} from "../training/training-model-data";
import type { LabWorkproductSummary } from "./lab-workproducts";
import {
  labWorkproductKindLabel,
  runsForWorkproduct,
} from "./lab-workproducts";
import type { LabDetailLocation } from "./lab-detail-navigation";
import { LabAgentEvalActions } from "./LabEvalActions";
import { LabAgentChanges } from "./LabAgentChanges";
import { LabAgentChangeHistory } from "./LabAgentChangeHistory";
import {
  LabModelVersionDetailPage,
  LabModelVersionsPage,
} from "./LabModelWorkspace";
import { LabNewVersionDialog } from "./LabNewVersionDialog";
import { LabRunDecisionSection } from "./LabRunDecisionSection";
import { LabStatusBadge, type LabStatusTone } from "./LabStatusBadge";
import { LabStatusDot } from "./LabStatusDot";
import { labModelVersions } from "./lab-models";
import { labWorkproductProgression } from "./lab-workproduct-progression";
import { Download, SquarePen } from "../icons";

type TrainingController = ReturnType<typeof useTraining>;
type WorkproductDetailTab =
  | "overview"
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
}: {
  workproduct: LabWorkproductSummary;
  runs: CreateImproveRun[];
  profile: OpenPondProfileState | null;
  training: TrainingController;
  connection: ClientConnection | null;
  onOpenConversation: (conversationId: string) => void;
  onLocationChange: (location: LabDetailLocation | null) => void;
  onRenameAgent: () => void;
  onStartAgentChange: (agentId: string, prompt?: string) => void;
  onOpenDataset: (tasksetId: string) => void;
  onToast: ShowAppToast;
  onAnswerQuestion: (
    input: CreateImproveReviewActionInput,
    questionId: string,
    answerValue: string
  ) => Promise<void>;
  onApprove: (input: CreateImproveReviewActionInput) => Promise<void>;
  onCancel: (input: CreateImproveReviewActionInput) => Promise<void>;
  onChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  onApplyCandidate: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
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
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  onPause: (input: CreateImproveReviewActionInput) => Promise<void>;
  onReconcilePullRequest: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  onRejectCandidate: (
    input: CreateImproveReviewActionInput,
    candidateId: string
  ) => Promise<void>;
  onResume: (input: CreateImproveReviewActionInput) => Promise<void>;
  onRevise: (
    input: CreateImproveReviewActionInput,
    revision: string
  ) => Promise<void>;
  candidateReview: {
    diff: WorkspaceDiffSummary | null;
    error: string | null;
    loading: boolean;
  };
}) {
  const workproductRuns = useMemo(
    () => runsForWorkproduct(workproduct, runs),
    [runs, workproduct]
  );
  const [selectedRunId, setSelectedRunId] = useState(
    workproductRuns[0]?.id ?? ""
  );
  const [selectedChangeRunId, setSelectedChangeRunId] = useState<string | null>(
    null
  );
  const [activeTab, setActiveTab] = useState<WorkproductDetailTab>("overview");
  const [selectedModelEntryKey, setSelectedModelEntryKey] = useState<
    string | null
  >(null);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [modelUseVersionId, setModelUseVersionId] = useState<string | null>(
    null,
  );
  const [startTraining, setStartTraining] = useState<{
    taskset: Taskset;
    method: "sft" | "grpo";
  } | null>(null);
  const selectedRun =
    workproductRuns.find((run) => run.id === selectedRunId) ??
    workproductRuns[0] ??
    null;
  const selectedChangeRun = selectedChangeRunId
    ? workproductRuns.find((run) => run.id === selectedChangeRunId) ?? null
    : null;
  const selectedChangeCandidate = selectedChangeRun
    ? latestReviewableCandidate(selectedChangeRun)
    : null;
  const locationKindLabel = labWorkproductKindLabel(workproduct.kind);
  const selectedChangeCommit = selectedChangeCandidate?.git?.headCommit ?? null;
  const locationSectionLabels = useMemo(
    () =>
      workproduct.kind === "model"
        ? selectedModelEntryKey
          ? ["Version details"]
          : []
        : detailBreadcrumbs(
            activeTab,
            selectedChangeRunId,
            selectedChangeCommit,
          ),
    [
      activeTab,
      selectedChangeCommit,
      selectedChangeRunId,
      selectedModelEntryKey,
      workproduct.kind,
    ]
  );
  const taskset = workproduct.tasksetId
    ? training.payload?.tasksets.find(
        (item) => item.id === workproduct.tasksetId
      ) ?? null
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
  const selectedRunAvailable = workproductRuns.some(
    (run) => run.id === selectedRunId
  );
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

  useEffect(() => {
    onCandidateReviewChange(null);
    setSelectedRunId(preferredRunId);
    setSelectedChangeRunId(null);
    setSelectedModelEntryKey(null);
    setActiveTab("overview");
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
    if (
      activeTab === "changes" &&
      selectedChangeRun &&
      selectedChangeCandidate
    ) {
      const scope = candidateFileScope(
        workproduct,
        profile,
        selectedChangeCandidate
      );
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
      workproductLabel: workproduct.name,
      sectionLabels: locationSectionLabels,
    });
  }, [
    locationKindLabel,
    locationSectionLabels,
    onLocationChange,
    workproduct.kind,
    workproduct.name,
  ]);

  useEffect(
    () => () => onCandidateReviewChange(null),
    [onCandidateReviewChange]
  );

  function useModelVersion(versionId: string) {
    const version = labModelVersions(
      workproduct,
      runs,
      training.payload,
    ).find((candidate) => candidate.lineage.id === versionId);
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

  return (
    <div className="training-model-detail labs-workproduct-detail">
      <header className="training-model-detail-header labs-workproduct-detail-header">
        <div>
          <div className="labs-workproduct-name-row">
            <h1>{workproduct.name}</h1>
            <LabStatusDot
              label={progression.statusLabel}
              value={progression.statusValue}
            />
          </div>
        </div>
        {workproduct.kind === "model" ? (
          <div className="labs-workproduct-header-actions">
            <button
              className="training-button"
              type="button"
              onClick={() => setNewVersionOpen(true)}
            >
              New version
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
              <button
                className="settings-secondary compact"
                type="button"
                onClick={onRenameAgent}
              >
                <SquarePen size={14} />
                <span>Rename</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {workproduct.kind !== "model" ? (
        <div
          className="training-detail-tabs"
          role="tablist"
          aria-label="Workproduct detail"
        >
          {detailTabs.map(([id, label]) => (
            <button
              className={activeTab === id ? "active" : undefined}
              aria-selected={activeTab === id}
              key={id}
              role="tab"
              type="button"
              onClick={() => {
                setActiveTab(id);
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
        </div>
      ) : null}

      <div className="training-detail-sections">
        {workproduct.kind === "model" ? (
          selectedModelEntryKey ? (
            <LabModelVersionDetailPage
              connection={connection}
              runs={runs}
              selectedEntryKey={selectedModelEntryKey}
              training={training}
              workproduct={workproduct}
              onBack={() => setSelectedModelEntryKey(null)}
              onOpenDataset={onOpenDataset}
              onUseVersion={useModelVersion}
            />
          ) : (
            <LabModelVersionsPage
              runs={runs}
              training={training}
              workproduct={workproduct}
              onOpenDataset={onOpenDataset}
              onOpenEntry={setSelectedModelEntryKey}
              onToast={onToast}
            />
          )
        ) : activeTab === "overview" ? (
          <DetailSection title="Overview">
            <dl className="labs-inline-facts">
              <Fact label="Type" value={titleCase(workproduct.kind)} />
              <Fact label="Status" value={progression.statusLabel} />
              <Fact label="ID" value={workproduct.id} />
              <Fact
                label="Path"
                value={workproduct.path ?? "Managed artifact"}
              />
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
        ) : activeTab === "changes" &&
          selectedChangeRun &&
          selectedChangeCandidate ? (
          <LabAgentChanges
            candidate={selectedChangeCandidate}
            diff={candidateReview.diff}
            error={candidateReview.error}
            run={selectedChangeRun}
            onApplyCandidate={(run, candidateId) =>
              onApplyCandidate({ run }, candidateId)
            }
            onOpenFiles={onOpenCandidateFiles}
            onRejectCandidate={(run, candidateId) =>
              onRejectCandidate({ run }, candidateId)
            }
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
              onRetry={() =>
                onStartAgentChange(workproduct.id, selectedChangeRun.objective)
              }
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
                        `Create an Eval for ${workproduct.name}. Describe the behavior this Eval should specify: `
                      )
                    }
                    onAttach={(evalRef) =>
                      onStartAgentChange(
                        workproduct.id,
                        `--eval ${JSON.stringify(evalRef)} Improve ${
                          workproduct.name
                        } using this existing Eval: `
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
                <Config
                  label="Profile"
                  value={profile?.activeProfile ?? "default"}
                />
                <Config
                  label="Conversation"
                  value={selectedRun?.scope.conversationId ?? "Not linked"}
                />
                <Config
                  label="Project"
                  value={selectedRun?.scope.projectId ?? "Not linked"}
                />
                <Config
                  label="Source authority"
                  value={selectedRun?.adapter.sourceAuthority ?? "Profile"}
                />
              </dl>
            </DetailSection>
            <WorkproductConfiguration
              workproduct={workproduct}
              profile={profile}
            />
          </>
        )}
      </div>

      {newVersionOpen ? (
        <LabNewVersionDialog
          initialTasksetId={taskset?.id ?? null}
          state={training.payload}
          onClose={() => setNewVersionOpen(false)}
          onContinue={(selection) => {
            setNewVersionOpen(false);
            setStartTraining(selection);
          }}
        />
      ) : null}

      {startTraining ? (
        <TrainingStartDialog
          busy={[
            "prepare-training",
            "start-prepared-training",
            "start-training",
          ].includes(training.busyAction ?? "")}
          connection={connection}
          destinations={training.payload?.destinations ?? []}
          initialMethod={startTraining.method}
          modelId={workproduct.id}
          preferredBaseModelId={preferredBaseModelId(workproductRuns)}
          taskset={startTraining.taskset}
          onClose={() => setStartTraining(null)}
          onPrepare={(destinationId, recipe, approval) =>
            training.actions.prepareTraining({
              modelId: workproduct.id,
              tasksetId: startTraining.taskset.id,
              destinationId,
              recipe,
              exportApproved: approval.exportApproved,
              retentionDays: approval.retentionDays,
              region: approval.region,
            })
          }
          onConfirmPrepared={async (prepared, maximumCostUsd) =>
            Boolean(
              await training.actions.startPreparedTraining({
                planId: prepared.plan.id,
                bundleId: prepared.bundle.id,
                maximumCostUsd,
              })
            )
          }
          onStart={async (destinationId, recipe, approval) =>
            Boolean(
              await training.actions.startTraining({
                modelId: workproduct.id,
                tasksetId: startTraining.taskset.id,
                destinationId,
                recipe,
                ...approval,
              })
            )
          }
        />
      ) : null}

      {modelUseVersionId
        ? (() => {
            const version = labModelVersions(
              workproduct,
              runs,
              training.payload,
            ).find(
              (candidate) =>
                candidate.lineage.id === modelUseVersionId,
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

function preferredBaseModelId(runs: CreateImproveRun[]): string | null {
  for (const run of runs) {
    const value = run.metadata.preferredBaseModelId;
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function latestReviewableCandidate(
  run: CreateImproveRun
): CreateImproveCandidate | null {
  return (
    [...run.candidates]
      .reverse()
      .find((candidate) => Boolean(candidate.git?.headCommit)) ?? null
  );
}

function changeDotTone(run: CreateImproveRun | null): LabStatusTone {
  if (!run) return "neutral";
  if (run.state === "released") return "positive";
  if (
    run.state === "blocked" ||
    run.state === "failed" ||
    run.state === "rejected"
  )
    return "negative";
  if (run.state === "reconciling_release") return "info";
  return "warning";
}

function WorkproductConfiguration({
  workproduct,
  profile,
}: {
  workproduct: LabWorkproductSummary;
  profile: OpenPondProfileState | null;
}) {
  if (workproduct.kind === "agent") {
    const agent =
      profile?.agents.find((item) => item.id === workproduct.id) ?? null;
    return (
      <DetailSection title="Agent">
        <dl className="training-configuration-list">
          <Config label="Enabled" value={agent?.enabled ? "Yes" : "No"} />
          <Config
            label="Source"
            value={agent?.path ?? workproduct.path ?? "Draft"}
          />
          <Config label="Default action" value={`${workproduct.id}.chat`} />
          <Config
            label="Profile checks"
            value={profile?.lastCheck?.status ?? "Not run"}
          />
        </dl>
      </DetailSection>
    );
  }
  if (workproduct.kind === "skill") {
    const skill =
      profile?.skills.find((item) => item.name === workproduct.id) ?? null;
    return (
      <DetailSection title="Skill">
        <dl className="training-configuration-list">
          <Config label="Enabled" value={skill?.enabled ? "Yes" : "No"} />
          <Config
            label="Validation"
            value={skill?.validationStatus ?? "Draft"}
          />
          <Config
            label="Source hash"
            value={skill?.sourceHash ?? "Not available"}
          />
          <Config
            label="Characters"
            value={skill ? String(skill.charCount) : "Not available"}
          />
        </dl>
        {skill?.validationMessages.length ? (
          <ul className="labs-validation-list">
            {skill.validationMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </DetailSection>
    );
  }
  if (workproduct.kind === "extension") {
    return (
      <DetailSection title="Extension">
        <div className="training-run-placeholder">
          Runtime bindings arrive with the Extension phase.
        </div>
      </DetailSection>
    );
  }
  return null;
}

function ActivitySection({
  runs,
  selectedRun,
  onSelectedRunIdChange,
}: {
  runs: CreateImproveRun[];
  selectedRun: CreateImproveRun | null;
  onSelectedRunIdChange: (runId: string) => void;
}) {
  return (
    <DetailSection title="Activity">
      {runs.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table labs-activity-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Operation</th>
                <th>State</th>
                <th>Revision</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  className={
                    run.id === selectedRun?.id ? "selected" : undefined
                  }
                  key={run.id}
                  onClick={() => onSelectedRunIdChange(run.id)}
                >
                  <td>{shortId(run.id)}</td>
                  <td>{run.operation}</td>
                  <td>
                    <LabStatusBadge
                      label={run.state.replaceAll("_", " ")}
                      value={run.state}
                    />
                  </td>
                  <td>{run.revision}</td>
                  <td>{formatDateTime(run.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="training-run-placeholder">
          No Create/Improve activity yet.
        </div>
      )}
    </DetailSection>
  );
}

function EvalSummary({
  profileEvals,
  run,
  workproduct,
}: {
  profileEvals: OpenPondProfileEval[];
  run: CreateImproveRun | null;
  workproduct: LabWorkproductSummary;
}) {
  const receipts = run?.evaluationReceipts ?? [];
  const attachedEvalRefs = [
    ...new Set([
      ...(run?.context.evalRefs ?? []),
      ...receipts.flatMap((receipt) => receipt.evalRefs),
    ]),
  ];
  const sourceEvals =
    workproduct.kind === "agent"
      ? profileEvals.filter(
          (item) => item.agentId === null || item.agentId === workproduct.id
        )
      : [];
  if (!receipts.length && !sourceEvals.length && !attachedEvalRefs.length) {
    return (
      <div className="training-run-placeholder">No Eval receipts yet.</div>
    );
  }
  return (
    <div className="labs-eval-summary">
      {sourceEvals.length ? (
        <div className="labs-source-evals">
          <strong>Available Evals</strong>
          <ul>
            {sourceEvals.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <code>{item.path}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {attachedEvalRefs.length ? (
        <div className="labs-source-evals">
          <strong>Used for this change</strong>
          <ul>
            {attachedEvalRefs.map((ref) => (
              <li key={ref}>
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {receipts.length ? (
        <div className="labs-eval-receipts">
          <strong>Eval receipts</strong>
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Status</th>
                  <th>Evals</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td>{shortId(receipt.id)}</td>
                    <td>
                      <LabStatusBadge label={receipt.status} />
                    </td>
                    <td>{receipt.evalRefs.length}</td>
                    <td>{receipt.summary ?? "No summary"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function VersionSummary({
  runs,
  selectedRun,
  taskset,
  training,
  trainingState,
  onToast,
}: {
  runs: CreateImproveRun[];
  selectedRun: CreateImproveRun | null;
  taskset: Taskset | null;
  training: TrainingController;
  trainingState: TrainingStateResponse | null;
  onToast: ShowAppToast;
}) {
  const models = (taskset
    ? trainingState?.models.filter((model) => model.tasksetId === taskset.id) ??
      []
    : []).sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  const jobById = new Map(
    trainingState?.jobs.map((job) => [job.id, job] as const) ?? []
  );
  const planById = new Map(
    trainingState?.plans.map((plan) => [plan.id, plan] as const) ?? []
  );
  const artifactById = new Map(
    trainingState?.artifacts.map((artifact) => [artifact.id, artifact] as const) ?? []
  );
  return (
    <>
      <p className="labs-detail-copy labs-version-storage-copy">
        OpenPond automatically saves provider weights in app-managed local storage.
        Download LoRA creates a portable copy for moving or sharing the adapter.
      </p>
      <dl className="labs-inline-facts">
        <Fact label="Create/Improve runs" value={String(runs.length)} />
        <Fact
          label="Candidates"
          value={String(selectedRun?.candidates.length ?? 0)}
        />
        <Fact
          label="Profile commit"
          value={selectedRun?.localProfileCommit ?? "Not released"}
        />
        <Fact label="Model artifacts" value={String(models.length)} />
      </dl>
      {models.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Method</th>
                <th>Storage</th>
                <th>Frozen Eval</th>
                <th>Imported</th>
                <th><span className="sr-only">Download</span></th>
              </tr>
            </thead>
            <tbody>
              {models.map((model, index) => {
                const job = jobById.get(model.jobId);
                const plan = job ? planById.get(job.planId) : null;
                const artifact = artifactById.get(model.artifactId) ?? null;
                const storageDirectory = artifact ? localArtifactDirectory(artifact.path) : null;
                return (
                  <tr key={model.id}>
                    <td className="labs-version-name">
                      <strong>{index === 0 ? "Latest" : `Prior ${index}`}</strong>
                      <small>{shortId(model.id)}</small>
                    </td>
                    <td>{trainingMethodLabel(plan?.recipe.method)}</td>
                    <td className="labs-version-storage">
                      <strong>{storageDirectory ? "Saved locally" : "Unavailable"}</strong>
                      {storageDirectory ? <code title={artifact?.path}>{storageDirectory}</code> : null}
                    </td>
                    <td>
                      {model.promotable
                        ? "Passed"
                        : model.frozenEvaluationArtifactId
                          ? "Failed"
                          : "Not run"}
                    </td>
                    <td>{formatDateTime(model.importedAt)}</td>
                    <td>
                      <button
                        className="training-button secondary"
                        type="button"
                        onClick={() =>
                          void training.actions.downloadModelPackage(model.id)
                        }
                      >
                        <Download size={14} />
                        Download LoRA
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="training-run-placeholder">
          Model versions appear after the first adapter is imported.
        </div>
      )}
      {models[0] ? (
        <div className="labs-version-promotion">
          <h3>Promotion &amp; bindings</h3>
          <TrainingModelPromotion
            lineage={models[0]}
            state={trainingState}
            training={training}
            onToast={onToast}
          />
        </div>
      ) : null}
    </>
  );
}

function localArtifactDirectory(artifactPath: string): string {
  const directory = artifactPath.replace(/[/\\][^/\\]+$/, "");
  return directory.replace(/^\/home\/[^/]+/, "~");
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Config({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function shortId(value: string): string {
  return value
    .replace(
      /^(create_improve|training_job|agent_candidate|model_candidate)_/,
      ""
    )
    .slice(0, 14);
}

function titleCase(value: string): string {
  return value
    ? `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("_", " ")}`
    : value;
}

function detailBreadcrumbs(
  activeTab: WorkproductDetailTab,
  selectedChangeRunId: string | null,
  changeCommit: string | null
): string[] {
  if (activeTab === "changes") {
    if (!selectedChangeRunId) return ["Changes"];
    return [
      "Changes",
      changeCommit
        ? `Change ${changeCommit.slice(0, 8)}`
        : `Change ${shortId(selectedChangeRunId)}`,
    ];
  }
  return [titleCase(activeTab)];
}

function candidateFileScope(
  workproduct: LabWorkproductSummary,
  profile: OpenPondProfileState | null,
  candidate: CreateImproveCandidate
): { fileRootPath: string | null; initialPath: string | null } {
  const changedPaths = candidate.git?.changedPaths ?? [];
  const fallbackPath = changedPaths[0] ?? null;
  const sourcePath = workproduct.path?.trim().replace(/^\.\/+|\/+$/g, "") ?? "";
  if (!sourcePath) return { fileRootPath: null, initialPath: fallbackPath };

  const segments = sourcePath.split("/").filter(Boolean);
  if (segments.at(-1)?.includes(".")) segments.pop();
  const relativeRoot = segments.join("/");
  if (!relativeRoot) return { fileRootPath: null, initialPath: fallbackPath };
  const fileRootPath = relativeRoot.startsWith("profiles/")
    ? relativeRoot
    : `profiles/${profile?.activeProfile ?? "default"}/${relativeRoot}`;
  const initialPath =
    changedPaths.find(
      (path) => path === fileRootPath || path.startsWith(`${fileRootPath}/`)
    ) ?? null;
  return initialPath
    ? { fileRootPath, initialPath }
    : { fileRootPath: null, initialPath: fallbackPath };
}

function changeStatusDescription(run: CreateImproveRun | null): string {
  if (!run) return "No change status";
  if (run.state === "awaiting_promotion") return "Change pending review";
  if (run.state === "released") return "Change merged";
  return `Change ${run.state.replaceAll("_", " ")}`;
}
