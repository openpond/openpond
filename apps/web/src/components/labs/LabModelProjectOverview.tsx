import type { ReactNode } from "react";
import type {
  ModelProject,
  ModelRun,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import { formatDateTime, statusLabel } from "../training/training-model-data";
import type { LabModelVersion } from "./lab-models";
import { LabContinualLearningSeries } from "./LabContinualLearningSeries";
import {
  isActiveRunStatus,
  LabRunStatusBadge,
} from "./LabRunStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { LabProjectMetricCharts } from "./LabProjectMetricCharts";

export function LabModelProjectOverview({
  actions,
  connection,
  modelProject,
  modelRuns,
  onOpenRun,
  state,
  status,
  versions,
}: {
  actions?: ReactNode;
  connection: ClientConnection | null;
  modelProject: ModelProject | null;
  modelRuns: ModelRun[];
  onOpenRun: (runId: string) => void;
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
  const latestEvaluation = orderedRuns.find((run) => run.kind === "evaluation") ?? null;
  const evaluationReceipt = latestEvaluation?.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
    ? latestEvaluation.receipt
    : null;
  const currentVersion = versions.find((version) => version.current) ?? versions[0] ?? null;
  const trainingModel = modelProject?.trainingSetup.baseModel ?? modelProject?.defaultBaseModel ?? null;
  const servingReady = currentVersion?.lineage.managedServing?.customerBindingAllowed ?? false;

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
              ? `${runKindLabel(currentRun)} · ${formatDateTime(currentRun.updatedAt)}`
              : `${modelProject?.tasksetSyncs.length ?? 0} attached Taskset release${modelProject?.tasksetSyncs.length === 1 ? "" : "s"}`,
            onSelect: currentRun ? () => onOpenRun(currentRun.id) : undefined,
            ariaLabel: currentRun
              ? `Open ${runKindLabel(currentRun)} run with status ${statusLabel(currentRun.status)}`
              : undefined,
          },
          {
            label: "Latest evaluation",
            value: evaluationReceipt
              ? percent(evaluationReceipt.quality.candidatePassRate)
              : latestEvaluation ? statusLabel(latestEvaluation.status) : "Not run",
            hint: evaluationReceipt
              ? `${signedPercent(evaluationReceipt.quality.candidatePassRate - evaluationReceipt.quality.baselinePassRate)} · retention ${evaluationReceipt.quality.heldOutCandidatePassed ? "passed" : "failed"}`
              : "No comparable evaluation result",
          },
        ]}
        status={status}
        title={modelProject?.name ?? "Model Project"}
      />
      <LabProjectMetricCharts runs={modelRuns} />
      <LabContinualLearningSeries
        connection={connection}
        onOpenRun={onOpenRun}
        runs={modelRuns}
        state={state}
      />
    </div>
  );
}

function runKindLabel(run: ModelRun): string {
  if (run.kind === "evaluation") return "Evaluation";
  if (run.kind === "rollout_smoke") return "Preflight rollout";
  return run.method ? `${run.method.toUpperCase()} training` : "Training";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number): string {
  const result = Math.round(value * 100);
  return `${result > 0 ? "+" : ""}${result}% vs baseline`;
}
