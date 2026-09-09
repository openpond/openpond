import type { ReactNode } from "react";
import type {
  ModelProject,
  TrainingStateResponse,
} from "@openpond/contracts";

import { formatDateTime, statusLabel } from "../training/training-model-data";
import type { LabModelVersion } from "./lab-models";
import { LabContinualLearningSeries } from "./LabContinualLearningSeries";
import {
  isActiveRunStatus,
  LabRunStatusBadge,
} from "./LabRunStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { LabProjectMetricCharts } from "./LabProjectMetricCharts";
import { modelProjectTasksetIds } from "./models-resource-scope";
import type { ModelOverviewRun } from "./model-overview-runs";

export function LabModelProjectOverview({
  actions,
  modelProject,
  modelRuns,
  onOpenRun,
  onOpenSeries,
  state,
  status,
  versions,
}: {
  actions?: ReactNode;
  modelProject: ModelProject | null;
  modelRuns: ModelOverviewRun[];
  onOpenRun: (runId: string) => void;
  onOpenSeries: (seriesId: string) => void;
  state: TrainingStateResponse | null;
  status?: ReactNode;
  versions: LabModelVersion[];
}) {
  const orderedRuns = [...modelRuns].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const currentRun =
    orderedRuns.find((run) => isActiveRunStatus(run.status)) ??
    orderedRuns[0] ??
    null;
  const latestEvaluation = orderedRuns.find((run) => run.evaluation || run.kind === "evaluation") ?? null;
  const evaluation = latestEvaluation?.evaluation;
  const currentVersion = versions.find((version) => version.current) ?? versions[0] ?? null;
  const trainingModel = modelProject?.trainingSetup.baseModel ?? modelProject?.defaultBaseModel ?? null;
  const servingReady = currentVersion?.lineage.managedServing?.customerBindingAllowed ?? false;
  const tasksetCount = modelProjectTasksetIds(modelProject).size;

  return (
    <div className="labs-model-overview">
      <ModelProjectPageHeader
        actions={actions}
        description={modelProject?.objective ?? "Training, evaluation, version, and serving state for this Model Project."}
        metrics={[
          {
            label: "Training model",
            value: trainingModel?.modelId ?? "Choose a model",
            hint: modelProject?.trainingSetup.method
              ? `${modelProject.trainingSetup.method.toUpperCase()} · ${trainingModel?.source ?? "unconfigured"}`
              : "Training setup is not configured",
          },
          {
            label: "Current version",
            value: currentVersion ? `Version ${currentVersion.number}` : "Base only",
            hint: currentVersion
              ? servingReady ? "Ready to serve" : "Not serving"
              : `${versions.length} trained version${versions.length === 1 ? "" : "s"}`,
          },
          {
            label: "Current run",
            value: currentRun
              ? <LabRunStatusBadge status={currentRun.status} />
              : "Not started",
            hint: currentRun
              ? `${currentRun.label} · ${formatDateTime(currentRun.updatedAt)}`
              : `${tasksetCount} attached Taskset release${tasksetCount === 1 ? "" : "s"}`,
            onSelect: currentRun ? () => onOpenRun(currentRun.key) : undefined,
            ariaLabel: currentRun
              ? `Open ${currentRun.label} run with status ${statusLabel(currentRun.status)}`
              : undefined,
          },
          {
            label: "Latest evaluation",
            value: evaluation
              ? evaluation.passRate ? percent(evaluation.score) : evaluation.score.toFixed(3)
              : latestEvaluation ? statusLabel(latestEvaluation.status) : "Not run",
            hint: evaluation
              ? evaluation.baseline === null ? "Retained candidate score" : evaluation.passRate
                ? `${signedPercent(evaluation.score - evaluation.baseline)} · retention ${evaluation.retentionPassed ? "passed" : "failed"}`
                : `Baseline ${evaluation.baseline.toFixed(3)} · retained evaluation`
              : "No comparable evaluation result",
          },
        ]}
        status={status}
        title={modelProject?.name ?? "Model Project"}
      />
      <LabProjectMetricCharts runs={modelRuns} />
      <LabContinualLearningSeries
        modelProjectId={modelProject?.id ?? null}
        onOpenRun={(runId) => onOpenRun(`model-run:${runId}`)}
        onOpenSeries={onOpenSeries}
        state={state}
      />
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number): string {
  const result = Math.round(value * 100);
  return `${result > 0 ? "+" : ""}${result}% vs baseline`;
}
