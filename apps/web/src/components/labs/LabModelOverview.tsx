import { useMemo } from "react";
import {
  managedAdapterCustomerBindingAllowed,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { statusLabel } from "../training/training-model-data";
import {
  labLifecycleModelRuns,
  labModelJobs,
  labModelVersions,
} from "./lab-models";
import { modelRunEntries, type ModelWorkspaceProps } from "./LabModelWorkspace";

type TrainingController = ReturnType<typeof useTraining>;
type ModelSummaryProps = Omit<ModelWorkspaceProps, "onOpenDataset">;

export function LabModelOverview({
  workproduct,
  runs,
  training,
}: ModelSummaryProps & {
  training: TrainingController;
}) {
  const state = training.payload;
  const jobs = useMemo(
    () => labModelJobs(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct],
  );
  const lifecycleRuns = useMemo(
    () => labLifecycleModelRuns(workproduct, state),
    [state, workproduct],
  );
  const runCount = useMemo(
    () => modelRunEntries(jobs, versions, lifecycleRuns).length,
    [jobs, lifecycleRuns, versions],
  );
  const latestRun = useMemo(
    () => modelRunEntries(jobs, versions, lifecycleRuns)[0] ?? null,
    [jobs, lifecycleRuns, versions],
  );
  const currentVersion = versions.find((version) => version.current) ?? null;
  const evaluation = versionEvaluation(
    currentVersion,
    workproduct.evaluationStatus,
  );
  const latestRunStatus =
    latestRun?.lifecycleRun?.status ?? latestRun?.job?.status ?? null;

  return (
    <section className="labs-model-overview" aria-label="Model summary">
      <div className="labs-model-kpi-grid">
        <OverviewKpi
          label="Active release"
          value={currentVersion ? `Version ${currentVersion.number}` : "None"}
          supporting={
            currentVersion
              ? "Used when you chat with this Model"
              : "No release is active"
          }
        />
        <OverviewKpi
          label="Recent run"
          value={latestRunStatus ? statusLabel(latestRunStatus) : "Not started"}
          supporting={
            latestRun
              ? latestRun.version
                ? `Run ${runCount} created Version ${latestRun.version.number}`
                : `Run ${runCount} has no trained output yet`
              : "Start a run to train this Model"
          }
        />
        <OverviewKpi
          label="Evaluation"
          value={evaluation.label}
          supporting={evaluation.supporting}
        />
        <OverviewKpi
          label="Runs"
          value={String(runCount)}
          supporting={`${versions.length} trained ${
            versions.length === 1 ? "Version" : "Versions"
          }`}
        />
      </div>
    </section>
  );
}

function OverviewKpi({
  label,
  value,
  supporting,
}: {
  label: string;
  value: string;
  supporting: string;
}) {
  return (
    <div className="labs-model-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{supporting}</small>
    </div>
  );
}

function versionEvaluation(
  version: ReturnType<typeof labModelVersions>[number] | null,
  workproductStatus: "not_run" | "passed" | "failed",
) {
  if (!version) {
    return {
      label: "Not run",
      supporting: "Train a Version before evaluating it",
    };
  }
  if (
    workproductStatus === "passed" ||
    resolveModelBindingPromotionGate(version.lineage) ||
    managedAdapterCustomerBindingAllowed(version.lineage)
  ) {
    return {
      label: "Passed",
      supporting: `Version ${version.number} is ready to use`,
    };
  }
  if (
    workproductStatus === "failed" ||
    version.job?.metadata.frozenEvaluationComplete === true ||
    version.lineage.frozenEvaluationArtifactId ||
    version.lineage.managedServing?.customerBindingAllowed
  ) {
    return {
      label: "Failed",
      supporting: `Version ${version.number} needs review`,
    };
  }
  return {
    label: "Not run",
    supporting: `Version ${version.number} has not been evaluated`,
  };
}
