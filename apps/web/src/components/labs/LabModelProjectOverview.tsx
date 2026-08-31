import type { ReactNode } from "react";
import type {
  ModelProject,
  ModelRun,
  TrainingStateResponse,
} from "@openpond/contracts";

import {
  formatDateTime,
  formatDuration,
  statusLabel,
  terminalRunEnd,
} from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import type { LabModelVersion } from "./lab-models";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { LabProjectMetricCharts } from "./LabProjectMetricCharts";

export function LabModelProjectOverview({
  actions,
  modelProject,
  modelRuns,
  state,
  status,
  versions,
}: {
  actions?: ReactNode;
  modelProject: ModelProject | null;
  modelRuns: ModelRun[];
  state: TrainingStateResponse | null;
  status?: ReactNode;
  versions: LabModelVersion[];
}) {
  const trainingRuns = modelRuns.filter((run) => run.kind !== "evaluation");
  const evaluationRuns = modelRuns.filter((run) => run.kind === "evaluation");
  const activeRun = trainingRuns.find((run) =>
    ["prepared", "running"].includes(run.status),
  ) ?? null;
  const latestTraining = trainingRuns[0] ?? null;
  const latestEvaluation = evaluationRuns[0] ?? null;
  const evaluationReceipt = latestEvaluation?.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
    ? latestEvaluation.receipt
    : null;
  const currentVersion = versions.find((version) => version.current) ?? versions[0] ?? null;
  const attachedTasksets = modelProject
    ? allTasksets(state).filter((taskset) =>
        modelProject.tasksetSyncs.some((sync) => sync.localTasksetId === taskset.id),
      )
    : [];
  const scorerCount = new Set(
    attachedTasksets.flatMap((taskset) =>
      taskset.graders.map((grader) => `${grader.id}:${grader.version}`),
    ),
  ).size;
  const pendingCalibration = attachedTasksets.reduce(
    (count, taskset) => count + taskset.graders.filter(
      (grader) => grader.kind === "model_judge" && grader.calibrationStatus !== "passed",
    ).length,
    0,
  );
  const reviewQueueCount = attachedTasksets.filter((taskset) =>
    taskset.preferenceComparison ||
    taskset.graders.some((grader) => grader.kind === "human") ||
    Boolean(taskset.metadata.tasksetReviewPolicy),
  ).length;
  const servingReady = versions.filter(
    (version) => version.lineage.managedServing?.customerBindingAllowed,
  ).length;

  return (
    <div className="labs-model-overview">
      <ModelProjectPageHeader
        actions={actions}
        description={modelProject?.objective ?? "Training, evaluation, version, and serving state for this Model Project."}
        metrics={[
          { label: "Current version", value: currentVersion ? `Version ${currentVersion.number}` : "Base only" },
          { label: "Taskset releases", value: modelProject?.tasksetSyncs.length ?? 0 },
          { label: "Scorer releases", value: scorerCount },
          { label: "Runs", value: modelRuns.length },
        ]}
        status={status}
        title={modelProject?.name ?? "Model Project"}
      />
      <section className="training-detail-section">
        <h2>Learning status</h2>
        <div className="labs-overview-decision-grid">
          <DecisionCard
            label="Training"
            status={activeRun ? statusLabel(activeRun.status) : latestTraining ? statusLabel(latestTraining.status) : "Not started"}
            tone={activeRun ? "running" : latestTraining?.status ?? "not_run"}
            value={activeRun
              ? progressLabel(activeRun)
              : latestTraining?.reward
                ? `Reward ${latestTraining.reward.raw.toFixed(3)}`
                : latestTraining
                  ? formatDateTime(latestTraining.updatedAt)
                  : "No training runs"}
          />
          <DecisionCard
            label="Latest evaluation"
            status={latestEvaluation ? statusLabel(latestEvaluation.status) : "Not run"}
            tone={latestEvaluation?.status ?? "not_run"}
            value={evaluationReceipt
              ? `${percent(evaluationReceipt.quality.candidatePassRate)} · ${signedPercent(evaluationReceipt.quality.candidatePassRate - evaluationReceipt.quality.baselinePassRate)}`
              : "No comparable result"}
          />
          <DecisionCard
            label="Retention"
            status={evaluationReceipt
              ? evaluationReceipt.quality.heldOutCandidatePassed ? "Passed" : "Needs attention"
              : "Not measured"}
            tone={evaluationReceipt?.quality.heldOutCandidatePassed ? "succeeded" : "not_run"}
            value={evaluationReceipt
              ? `New-task slice ${evaluationReceipt.quality.adaptationCandidatePassed ? "passed" : "failed"}`
              : "Run a frozen evaluation"}
          />
          <DecisionCard
            label="Serving"
            status={servingReady ? "Ready" : "Not published"}
            tone={servingReady ? "available" : "not_run"}
            value={servingReady ? `${servingReady} deployable version${servingReady === 1 ? "" : "s"}` : "No customer binding"}
          />
        </div>
      </section>
      <section className="training-detail-section">
        <h2>Readiness</h2>
        <dl className="labs-inline-facts">
          <Fact label="Attached Tasksets" value={String(attachedTasksets.length)} />
          <Fact label="Scorers" value={String(scorerCount)} />
          <Fact label="Calibration attention" value={String(pendingCalibration)} />
          <Fact label="Human review queues" value={String(reviewQueueCount)} />
          <Fact label="Model Versions" value={String(versions.length)} />
          <Fact label="Evaluation runs" value={String(evaluationRuns.length)} />
          <Fact label="Hosted revision" value={String(modelProject?.hosted?.revision ?? "Local")} />
        </dl>
      </section>
      <LabProjectMetricCharts runs={modelRuns} />
      {latestTraining ? (
        <section className="training-detail-section">
          <h2>Latest training run</h2>
          <dl className="training-configuration-list">
            <Fact label="Status" value={statusLabel(latestTraining.status)} />
            <Fact label="Method" value={latestTraining.method?.toUpperCase() ?? "—"} />
            <Fact label="Reward" value={latestTraining.reward ? latestTraining.reward.raw.toFixed(4) : "Not reported"} />
            <Fact
              label="Duration"
              value={formatDuration(
                latestTraining.startedAt,
                terminalRunEnd(latestTraining.status, latestTraining.completedAt, latestTraining.updatedAt),
              )}
            />
            <Fact label="Taskset" value={attachedTasksets.find((taskset) => taskset.id === latestTraining.taskset.id)?.name ?? latestTraining.taskset.id} />
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function DecisionCard({
  label,
  status,
  tone,
  value,
}: {
  label: string;
  status: string;
  tone: string;
  value: string;
}) {
  return (
    <article className="labs-overview-decision-card">
      <header>
        <span>{label}</span>
        <LabStatusBadge label={status} value={tone} pulse={tone === "running"} />
      </header>
      <strong>{value}</strong>
    </article>
  );
}

function allTasksets(state: TrainingStateResponse | null) {
  const tasksets = new Map<string, TrainingStateResponse["tasksets"][number]>();
  for (const taskset of [...(state?.tasksets ?? []), ...(state?.modelTasksets ?? [])]) {
    tasksets.set(`${taskset.id}:${taskset.revision}:${taskset.contentHash}`, taskset);
  }
  return [...tasksets.values()];
}

function progressLabel(run: ModelRun): string {
  if (!run.evaluationProgress) return "Preparing rollout groups";
  return `${run.evaluationProgress.completedAttempts}/${run.evaluationProgress.totalAttempts} attempts`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number): string {
  const result = Math.round(value * 100);
  return `${result > 0 ? "+" : ""}${result}% vs baseline`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
