import { useMemo } from "react";
import {
  managedAdapterCustomerBindingAllowed,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";
import {
  labBaseModelVersion,
  labLifecycleModelRuns,
  labModelJobs,
  labModelTasksets,
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
  const currentVersion = versions.find((version) => version.current) ?? null;
  const evaluation = versionEvaluation(
    currentVersion,
    workproduct.evaluationStatus,
  );

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
          label="Hosting"
          value={currentVersion ? "Ready" : "Not hosted"}
          supporting={
            currentVersion
              ? "Available through OpenPond"
              : "Activate a passing release to host it"
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

export function LabModelDetails({
  workproduct,
  runs,
  training,
}: ModelSummaryProps) {
  const state = training.payload;
  const versions = labModelVersions(workproduct, runs, state);
  const currentVersion = versions.find((version) => version.current) ?? null;
  const baseVersion = labBaseModelVersion(workproduct, state);
  const project =
    state?.modelProjects.find((candidate) => candidate.id === workproduct.id) ??
    null;
  const tasksets = labModelTasksets(state);
  const dataset =
    currentVersion?.taskset ??
    (baseVersion
      ? tasksets.find((taskset) => taskset.id === baseVersion.taskset.id) ??
        null
      : null);

  return (
    <DetailSection title="Details">
      <dl className="training-configuration-list">
        <Fact
          label="Base model"
          value={
            baseVersion?.baseModel.modelId ??
            project?.defaultBaseModel?.modelId ??
            "Not selected"
          }
        />
        <Fact label="Dataset" value={dataset?.name ?? "Not selected"} />
        <Fact
          label="Profile"
          value={workproduct.ownerProfileId ?? "Unknown"}
        />
        <Fact label="Model ID" value={workproduct.id} />
      </dl>
      {workproduct.description ? (
        <p className="labs-detail-copy">{workproduct.description}</p>
      ) : null}
    </DetailSection>
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
