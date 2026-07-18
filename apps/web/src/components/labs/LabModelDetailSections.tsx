import { useEffect, useMemo, useState } from "react";
import type {
  ChatModelRef,
  CrossSystemFrontierBaselineRun,
  TaskCreationSnapshot,
  Taskset,
  TrainingJob,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import {
  buildTrainingModelChatHandoff,
  type TrainingModelChatHandoff,
} from "../../lib/training-model-chat-handoff";
import { MessageSquare, Play } from "../icons";
import { DetailSection } from "../training/DetailSection";
import { TrainingModelConfiguration } from "../training/TrainingModelConfiguration";
import {
  TrainingModelComparisons,
  TrainingRolloutReceipts,
} from "../training/TrainingModelEvidence";
import { TrainingRunEvaluation } from "../training/TrainingRunEvaluation";
import { TrainingRunMetrics } from "../training/TrainingRunMetrics";
import {
  artifactsForJob,
  destinationLabel,
  formatDateTime,
  formatDuration,
  jobsForTaskset,
  planForJob,
  statusLabel,
  trainingMethodLabel,
  trainingMethodName,
  trainingRunMethodLabel,
} from "../training/training-model-data";
import { useTrainingRunDetail } from "../training/useTrainingRunDetail";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  LabModelBaselineData,
  LabModelBaselineEvals,
} from "./LabModelBaseline";
import { LabModelDataset } from "./LabModelDataset";
import { LabExpertBootstrap } from "./LabExpertBootstrap";

type TrainingController = ReturnType<typeof useTraining>;

export function LabModelOverview({
  creation,
  taskset,
  training,
  onResumeAuthoring,
  onChatWithModel,
  onToast,
}: {
  creation: TaskCreationSnapshot | null;
  taskset: Taskset | null;
  training: TrainingController;
  onResumeAuthoring: (creation: TaskCreationSnapshot) => void;
  onChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  onToast: ShowAppToast;
}) {
  if (!taskset) {
    const failed = creation?.state === "failed";
    return (
      <DetailSection
        title="Model data"
        actions={creation ? (
          <button
            className="training-button"
            type="button"
            onClick={() => onResumeAuthoring(creation)}
          >
            {failed ? "Review failure" : "Resume authoring"}
          </button>
        ) : null}
      >
        <div className={`training-run-placeholder${failed ? " error" : ""}`}>
          {failed
            ? modelAuthoringFailureCopy(creation.blockedReason)
            : "The model data is still being created."}
        </div>
      </DetailSection>
    );
  }
  const lineage = training.payload?.models
    .filter((model) => model.tasksetId === taskset.id && model.status === "imported")
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0] ?? null;
  const trainingExamples = taskset.learningSignals.demonstrations.filter((item) => item.approved).length;
  const evaluationExamples = taskset.tasks.filter((item) => item.split === "frozen_eval").length;

  return (
    <>
      <DetailSection title="Model">
        <div className="training-taskset-facts">
          <span><strong>{trainingExamples}</strong> training examples</span>
          <span><strong>{evaluationExamples}</strong> frozen Evals</span>
          <span><strong>{taskset.sourceRefs.length}</strong> dataset sources</span>
          <span><strong>{trainingMethodLabel(taskset.readiness?.recommendedMethod)}</strong> path</span>
        </div>
      </DetailSection>
      <DetailSection
        title="Chat"
        actions={lineage ? (
          <button
            aria-label={`Chat with ${taskset.name}`}
            className="training-button secondary"
            type="button"
            disabled={!lineage.promotable}
            title={lineage.promotable
              ? "Start a bounded chat session with this model"
              : "Chat is available after a version passes frozen evaluation"}
            onClick={() => onChatWithModel(buildTrainingModelChatHandoff({
              modelId: lineage.id,
              taskset,
            }))}
          >
            <MessageSquare size={14} />
            Chat
          </button>
        ) : null}
      >
        {lineage && !lineage.promotable ? (
          <div className="training-run-placeholder">
            Chat is unavailable because this version did not pass frozen evaluation.
          </div>
        ) : null}
        <TrainingModelConfiguration lineage={lineage} training={training} onToast={onToast} />
      </DetailSection>
    </>
  );
}

function modelAuthoringFailureCopy(reason: string | null): string {
  if (!reason) return "Taskset authoring failed before model data was created.";
  if (reason.trim().toLowerCase() === "terminated") {
    return "OpenPond Chat closed the Taskset authoring stream before a proposal was returned. No Taskset was created.";
  }
  return reason;
}

export function LabModelData({
  frontierBaseline,
  taskset,
  training,
  onOpenFiles,
  onToast,
}: {
  frontierBaseline: CrossSystemFrontierBaselineRun | null;
  taskset: Taskset | null;
  training: TrainingController;
  onOpenFiles: () => void;
  onToast: ShowAppToast;
}) {
  if (!taskset) {
    if (frontierBaseline) {
      return <LabModelBaselineData run={frontierBaseline} />;
    }
    return (
      <DetailSection title="Data">
        <div className="training-run-placeholder">The model data is still being created.</div>
      </DetailSection>
    );
  }
  return (
    <>
      <LabModelDataset taskset={taskset} onOpenFiles={onOpenFiles} />
      {taskset.metadata.flagship === "cross-system-operations" ? (
        <LabExpertBootstrap
          busyAction={training.busyAction}
          taskset={taskset}
          onApprove={(previewHash) => training.actions.approveExpertBootstrap(taskset.id, previewHash)}
          onPreview={() => training.actions.previewExpertBootstrap(taskset.id)}
          onToast={onToast}
        />
      ) : null}
    </>
  );
}

export function LabModelEvals({
  connection,
  defaultModel,
  frontierBaseline,
  taskset,
  training,
  trainingState,
  onOpenFiles,
  onToast,
}: {
  connection: ClientConnection | null;
  defaultModel: ChatModelRef;
  frontierBaseline: CrossSystemFrontierBaselineRun | null;
  taskset: Taskset | null;
  training: TrainingController;
  trainingState: TrainingStateResponse | null;
  onOpenFiles: () => void;
  onToast: ShowAppToast;
}) {
  const jobs = useMemo(
    () => taskset ? jobsForTaskset(trainingState, taskset.id) : [],
    [taskset, trainingState],
  );
  const methods = useMemo(
    () => availableTrainingMethods(taskset, jobs, trainingState),
    [jobs, taskset, trainingState],
  );
  const initialMethod = methodForJob(trainingState, jobs[0])
    ?? recommendedTrainingMethod(taskset);
  const [method, setMethod] = useState<"sft" | "grpo">(initialMethod);
  const methodJobs = useMemo(
    () => jobs.filter((job) => methodForJob(trainingState, job) === method),
    [jobs, method, trainingState],
  );
  const latestJob = methodJobs[0] ?? null;
  const evaluationDetail = useTrainingRunDetail(
    connection,
    latestJob?.id ?? null,
    latestJob?.status ?? null,
  );
  if (!taskset) {
    if (frontierBaseline) {
      return <LabModelBaselineEvals run={frontierBaseline} />;
    }
    return (
      <DetailSection title="Evals">
        <div className="training-run-placeholder">The Eval set is still being created.</div>
      </DetailSection>
    );
  }
  const baselines = trainingState?.baselineReports
    .filter((report) => report.tasksetId === taskset.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
  const audits = trainingState?.graderAuditReports
    .filter((report) => report.tasksetId === taskset.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
  const latestBaseline = baselines[0] ?? null;
  const latestAudit = audits[0] ?? null;
  const runningEvals = ["audit-graders", "baseline", "readiness"].includes(
    training.busyAction ?? "",
  );

  useEffect(() => {
    if (!methods.includes(method)) setMethod(methods[0] ?? recommendedTrainingMethod(taskset));
  }, [method, methods, taskset]);

  async function runEvals() {
    const audit = await training.actions.auditGraders(taskset!.id);
    if (!audit) return;
    const baseline = await training.actions.baseline(taskset!.id, [defaultModel]);
    if (!baseline) return;
    const readiness = await training.actions.readiness(taskset!.id);
    onToast(
      readiness ? "Baseline Evals complete. Training readiness updated." : "Baseline Evals could not be completed.",
      readiness ? "success" : "error",
    );
  }

  return (
    <>
      <DetailSection
        title="Evals"
        actions={(
          <div className="training-table-actions">
            <button
              className="training-button"
              disabled={runningEvals || Boolean(training.busyAction)}
              type="button"
              onClick={() => void runEvals()}
            >
              {runningEvals ? "Running baseline" : "Run baseline"}
            </button>
            <button className="training-button secondary" type="button" onClick={onOpenFiles}>
              Open Eval files
            </button>
          </div>
        )}
      >
        <div className="labs-method-tabs" role="tablist" aria-label="Evaluation methods">
          {methods.map((candidate) => (
            <button
              aria-selected={candidate === method}
              className={candidate === method ? "active" : ""}
              key={candidate}
              role="tab"
              type="button"
              onClick={() => setMethod(candidate)}
            >
              <span>{trainingMethodName(candidate)}</span>
              <strong>{trainingMethodLabel(candidate)}</strong>
            </button>
          ))}
        </div>
        <p className="labs-detail-copy labs-eval-copy">
          Every imported LoRA is automatically scored against the same frozen examples.
          Baseline results stay separate from training metrics.
        </p>
        <dl className="labs-inline-facts">
          <Fact label="Frozen examples" value={String(taskset.tasks.filter((task) => task.split === "frozen_eval").length)} />
          <Fact label="Candidate" value={latestJob ? statusLabel(latestJob.status) : "Not trained"} />
          <Fact label="Baseline" value={latestBaseline ? baselineLabel(latestBaseline.passAtK) : "Not run"} />
          <Fact label="Grader audit" value={latestAudit ? (latestAudit.passed ? "Passed" : "Failed") : "Not run"} />
        </dl>
      </DetailSection>
      <DetailSection title={`${trainingMethodLabel(method)} results`}>
        <TrainingModelComparisons method={method} taskset={taskset} state={trainingState} />
      </DetailSection>
      <DetailSection title={`${trainingMethodLabel(method)} frozen Eval`}>
        {latestJob ? (
          <>
            <dl className="labs-inline-facts">
              <Fact label="Run" value={latestJob.id} />
              <Fact label="Status" value={statusLabel(latestJob.status)} />
              <Fact label="Completed" value={formatDateTime(latestJob.completedAt)} />
            </dl>
            {evaluationDetail.error ? (
              <div className="training-run-placeholder error">
                {evaluationDetail.error}
              </div>
            ) : null}
            <TrainingRunEvaluation
              detail={evaluationDetail.detail}
              loading={evaluationDetail.loading}
            />
          </>
        ) : (
          <div className="training-run-placeholder">
            No trained candidate has been evaluated yet.
          </div>
        )}
      </DetailSection>
      <DetailSection title="Evaluation setup">
        <details className="labs-eval-setup">
          <summary>{taskset.graders.length} grader{taskset.graders.length === 1 ? "" : "s"} · inspect checks and gates</summary>
          <div className="training-table-wrap">
            <table className="training-data-table labs-model-eval-table">
              <thead>
                <tr><th>Check</th><th>Kind</th><th>Weight</th><th>Gate</th></tr>
              </thead>
              <tbody>
                {taskset.graders.map((grader) => (
                  <tr key={grader.id}>
                    <td>{grader.label}</td>
                    <td>{grader.kind.replaceAll("_", " ")}</td>
                    <td>{grader.weight}</td>
                    <td>{grader.hardGate ? "Required" : "Scored"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </DetailSection>
      {latestAudit?.failures.length ? (
        <DetailSection title="Audit failures">
          <ul className="labs-validation-list">
            {latestAudit.failures.map((failure) => (
              <li key={`${failure.fixtureId}:${failure.gradeId}`}>{failure.reason}</li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
    </>
  );
}

export function LabModelTraining({
  connection,
  taskset,
  training,
  onStartTraining,
}: {
  connection: ClientConnection | null;
  taskset: Taskset | null;
  training: TrainingController;
  onStartTraining: (method: "sft" | "grpo") => void;
}) {
  const jobs = useMemo(
    () => taskset ? jobsForTaskset(training.payload, taskset.id) : [],
    [taskset, training.payload],
  );
  const methods = useMemo(
    () => availableTrainingMethods(taskset, jobs, training.payload),
    [jobs, taskset, training.payload],
  );
  const initialMethod = methodForJob(training.payload, jobs[0])
    ?? recommendedTrainingMethod(taskset);
  const [method, setMethod] = useState<"sft" | "grpo">(initialMethod);
  const methodJobs = useMemo(
    () => jobs.filter((job) => methodForJob(training.payload, job) === method),
    [jobs, method, training.payload],
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(methodJobs[0]?.id ?? null);
  const selectedJob = methodJobs.find((job) => job.id === selectedJobId) ?? methodJobs[0] ?? null;
  const selectedPlan = planForJob(training.payload, selectedJob);
  const artifacts = artifactsForJob(training.payload, selectedJob?.id ?? null);
  const lineage = selectedJob
    ? training.payload?.models.find((model) => model.jobId === selectedJob.id) ?? null
    : null;
  const rolloutReceipts = selectedJob
    ? training.payload?.rolloutReceipts.filter((receipt) => receipt.jobId === selectedJob.id) ?? []
    : [];
  const detail = useTrainingRunDetail(connection, selectedJob?.id ?? null, selectedJob?.status ?? null);
  const canStart = jobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.status));

  useEffect(() => {
    if (!methods.includes(method)) {
      setMethod(methods[0] ?? recommendedTrainingMethod(taskset));
      return;
    }
    if (!selectedJobId || !methodJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(methodJobs[0]?.id ?? null);
    }
  }, [method, methodJobs, methods, selectedJobId, taskset]);

  if (!taskset) {
    return (
      <DetailSection title="Training">
        <div className="training-run-placeholder">The model data is still being created.</div>
      </DetailSection>
    );
  }

  const trainingExampleCount = method === "grpo"
    ? taskset.tasks.filter((task) => task.split === "train").length
    : taskset.learningSignals.demonstrations.filter((signal) => signal.approved).length;
  const recommended = recommendedTrainingMethod(taskset);

  return (
    <>
      <DetailSection
        title="Training"
        actions={canStart ? (
          <button
            className="training-button"
            type="button"
            disabled={!taskset.readiness?.ready || Boolean(training.busyAction)}
            onClick={() => onStartTraining(method)}
          >
            <Play size={14} />
            Start {trainingMethodName(method).toLowerCase()}
          </button>
        ) : null}
      >
        <div className="labs-method-tabs" role="tablist" aria-label="Training methods">
          {methods.map((candidate) => (
            <button
              aria-selected={candidate === method}
              className={candidate === method ? "active" : ""}
              key={candidate}
              role="tab"
              type="button"
              onClick={() => setMethod(candidate)}
            >
              <span>{trainingMethodName(candidate)}</span>
              <strong>{trainingMethodLabel(candidate)}</strong>
            </button>
          ))}
        </div>
        <dl className="labs-inline-facts">
          <Fact label="Method" value={trainingMethodLabel(method)} />
          <Fact
            label={method === "grpo" ? "Training prompts" : "Demonstrations"}
            value={String(trainingExampleCount)}
          />
          <Fact label="Runs" value={String(methodJobs.length)} />
          <Fact label="Recommended" value={method === recommended ? "Yes" : trainingMethodLabel(recommended)} />
        </dl>
        {!taskset.readiness?.ready && taskset.readiness?.blockers.length ? (
          <ul className="labs-validation-list">
            {taskset.readiness.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
          </ul>
        ) : null}
      </DetailSection>
      <DetailSection title={`${trainingMethodName(method)} runs`}>
        <TrainingJobsTable
          jobs={methodJobs}
          selectedJobId={selectedJob?.id ?? null}
          trainingState={training.payload}
          onSelect={setSelectedJobId}
        />
      </DetailSection>
      {selectedJob ? (
        <>
          <DetailSection title={`${trainingMethodLabel(method)} run`}>
            <dl className="labs-inline-facts">
              <Fact label="Status" value={statusLabel(selectedJob.status)} />
              <Fact label="Compute" value={selectedPlan ? destinationLabel(selectedPlan.destinationId) : selectedJob.destinationId} />
              <Fact label="Duration" value={formatDuration(selectedJob.startedAt, selectedJob.completedAt)} />
              <Fact label="Output" value={lineage ? "LoRA saved locally" : "Not imported"} />
            </dl>
            {selectedJob.error ? <p className="labs-training-error">{selectedJob.error}</p> : null}
            <details className="labs-run-technical">
              <summary>Technical details</summary>
              <dl className="training-configuration-list">
                <Fact label="Run" value={selectedJob.id} />
                <Fact label="Plan" value={selectedJob.planId} />
                <Fact label="Prepared data hash" value={selectedJob.bundleHash} />
                <Fact label="Artifacts" value={String(artifacts.length)} />
              </dl>
            </details>
          </DetailSection>
          <DetailSection title={method === "grpo" ? "Rollout scores" : "Training metrics"}>
            <TrainingRunMetrics detail={detail.detail} loading={detail.loading} error={detail.error} />
          </DetailSection>
          <DetailSection title="Output">
            <div className="training-result-summary">
              <strong>
                {lineage
                  ? `${trainingRunMethodLabel(taskset, selectedPlan)} LoRA saved locally`
                  : selectedJob.status === "succeeded"
                    ? "Importing provider output"
                    : "No LoRA created"}
              </strong>
              {selectedPlan && (selectedPlan.recipe.method === "sft" || selectedPlan.recipe.method === "grpo")
                ? <span>{selectedPlan.recipe.baseModel.id}</span>
                : null}
              {lineage ? (
                <span>
                  Frozen Eval {lineage.frozenEvaluationArtifactId ? "complete" : "not run"}.
                  Review quality and activation from Evals and Versions.
                </span>
              ) : null}
            </div>
          </DetailSection>
          {selectedPlan?.recipe.method === "grpo" ? (
            <DetailSection title="Rollout traces">
              <TrainingRolloutReceipts receipts={rolloutReceipts} />
            </DetailSection>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function TrainingJobsTable({
  jobs,
  selectedJobId,
  trainingState,
  onSelect,
}: {
  jobs: TrainingJob[];
  selectedJobId: string | null;
  trainingState: TrainingStateResponse | null;
  onSelect: (jobId: string) => void;
}) {
  if (!jobs.length) return <div className="training-run-placeholder">No training runs yet.</div>;
  return (
    <div className="training-table-wrap">
      <table className="training-data-table training-runs-table">
        <thead><tr><th>Run</th><th>Base model</th><th>Started</th><th>Status</th></tr></thead>
        <tbody>
          {jobs.map((job) => {
            const plan = trainingState?.plans.find((item) => item.id === job.planId) ?? null;
            return (
              <tr
                className={job.id === selectedJobId ? "selected" : undefined}
                key={job.id}
                onClick={() => onSelect(job.id)}
              >
                <td><button type="button" onClick={() => onSelect(job.id)}>{shortId(job.id)}</button></td>
                <td>{baseModelName(plan)}</td>
                <td>{formatDateTime(job.startedAt ?? job.createdAt)}</td>
                <td><LabStatusBadge label={statusLabel(job.status)} value={job.status} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function availableTrainingMethods(
  taskset: Taskset | null,
  jobs: TrainingJob[],
  state: TrainingStateResponse | null,
): Array<"sft" | "grpo"> {
  const methods = new Set<"sft" | "grpo">();
  if (taskset) {
    for (const method of taskset.capabilities.compatibleMethods) {
      if (method === "sft" || method === "grpo") methods.add(method);
    }
    if (taskset.readiness?.trainingPath?.bootstrap?.method === "sft") methods.add("sft");
    if (taskset.readiness?.trainingPath?.primaryMethod === "grpo") methods.add("grpo");
  }
  for (const job of jobs) {
    const method = methodForJob(state, job);
    if (method) methods.add(method);
  }
  const ordered: Array<"sft" | "grpo"> = [];
  if (methods.has("sft")) ordered.push("sft");
  if (methods.has("grpo")) ordered.push("grpo");
  return ordered.length ? ordered : ["sft"];
}

function recommendedTrainingMethod(taskset: Taskset | null): "sft" | "grpo" {
  const method = taskset?.readiness?.trainingPath?.primaryMethod
    ?? taskset?.readiness?.recommendedMethod
    ?? taskset?.metadata.trainingMethod;
  return method === "grpo" ? "grpo" : "sft";
}

function methodForJob(
  state: TrainingStateResponse | null,
  job: TrainingJob | undefined,
): "sft" | "grpo" | null {
  if (!job) return null;
  const method = state?.plans.find((plan) => plan.id === job.planId)?.recipe.method;
  return method === "sft" || method === "grpo" ? method : null;
}

function baseModelName(plan: ReturnType<typeof planForJob>): string {
  if (!plan || (plan.recipe.method !== "sft" && plan.recipe.method !== "grpo")) return "Not recorded";
  return plan.recipe.baseModel.id.split("/").at(-1) ?? plan.recipe.baseModel.id;
}

function baselineLabel(passAtK: Record<string, number>): string {
  const entries = Object.entries(passAtK);
  if (!entries.length) return "Complete";
  const [k, score] = entries.sort(([left], [right]) => Number(left) - Number(right))[0]!;
  return `pass@${k} ${(score * 100).toFixed(0)}%`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function shortId(value: string): string {
  return value.replace(/^training_job_/, "").slice(0, 12);
}
