import { useEffect, useMemo, useState } from "react";
import {
  type ManagedAdapterServingProjection,
  type TrainingJobEvent,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import { DetailSection } from "../training/DetailSection";
import { TrainingRolloutReceipts } from "../training/TrainingModelEvidence";
import { TrainingRunEvaluation } from "../training/TrainingRunEvaluation";
import { TrainingRunMetrics } from "../training/TrainingRunMetrics";
import {
  destinationLabel,
  formatDateTime,
  formatDuration,
  statusLabel,
  trainingMethodLabel,
} from "../training/training-model-data";
import { useTrainingRunDetail } from "../training/useTrainingRunDetail";
import { LabLifecycleRunMetrics } from "./LabLifecycleRunMetrics";
import { LabModelRunSummary } from "./LabModelRunSummary";
import {
  labLifecycleModelRuns,
  labModelJobs,
  labModelPlans,
  labModelTasksets,
  labModelVersions,
} from "./lab-models";
import {
  modelRunEntries,
  modelVersionEntries,
  type ModelWorkspaceProps,
} from "./LabModelWorkspace";

export function LabModelVersionDetailPage({
  connection,
  selectedEntryKey,
  workproduct,
  runs,
  training,
  onOpenDataset,
  onTabChange,
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
  selectedEntryKey: string;
  onTabChange?: (
    tab: "summary" | "metrics" | "evals" | "artifacts" | "logs"
  ) => void;
}) {
  const [activeRunTab, setActiveRunTab] = useState<
    "summary" | "metrics" | "evals" | "artifacts" | "logs"
  >("summary");
  const state = training.payload;
  const jobs = useMemo(
    () => labModelJobs(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const versions = useMemo(
    () => labModelVersions(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const lifecycleRuns = useMemo(
    () => labLifecycleModelRuns(workproduct, state),
    [state, workproduct]
  );
  const plans = useMemo(
    () => labModelPlans(workproduct, runs, state),
    [runs, state, workproduct]
  );
  const planById = useMemo(
    () => new Map(plans.map((plan) => [plan.id, plan] as const)),
    [plans]
  );
  const entries = useMemo(
    () => modelVersionEntries(jobs, versions),
    [jobs, versions]
  );
  const selectedEntry =
    entries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const selectedLifecycleRunId = selectedEntryKey.startsWith("model-run:")
    ? selectedEntryKey.slice("model-run:".length)
    : null;
  const selectedLifecycleRun = selectedLifecycleRunId
    ? lifecycleRuns.find((run) => run.id === selectedLifecycleRunId) ?? null
    : selectedEntry?.job
    ? lifecycleRuns.find(
        (run) => run.id === selectedEntry.job?.metadata.modelRunId
      ) ?? null
    : null;
  const selectedJob =
    selectedEntry?.job ??
    (selectedLifecycleRun
      ? state?.jobs.find(
          (job) =>
            job.id === selectedLifecycleRun.id ||
            job.metadata.modelRunId === selectedLifecycleRun.id
        ) ?? null
      : null);
  const runEntries = useMemo(
    () => modelRunEntries(jobs, versions, lifecycleRuns),
    [jobs, lifecycleRuns, versions]
  );
  const selectedRunIndex = runEntries.findIndex(
    (entry) =>
      entry.key === selectedEntryKey ||
      (selectedJob !== null && entry.job?.id === selectedJob.id) ||
      (selectedLifecycleRun !== null &&
        entry.lifecycleRun?.id === selectedLifecycleRun.id)
  );
  const selectedRunNumber =
    selectedRunIndex < 0 ? null : runEntries.length - selectedRunIndex;
  const selectedVersion =
    selectedEntry?.version ??
    (selectedLifecycleRun?.adapterArtifactLineageId
      ? versions.find(
          (version) =>
            version.lineage.id === selectedLifecycleRun.adapterArtifactLineageId
        ) ?? null
      : null);
  const selectedBaseModelId =
    (selectedLifecycleRun
      ? state?.modelVersions.find(
          (version) => version.id === selectedLifecycleRun.modelVersionId
        )?.baseModel.modelId
      : null) ??
    state?.modelVersions
      .filter(
        (version) =>
          version.modelId === workproduct.id &&
          version.kind === "base_reference"
      )
      .sort((left, right) => right.version - left.version)[0]?.baseModel
      .modelId ??
    null;
  const selectedEvaluationArtifactId =
    selectedVersion?.lineage.frozenEvaluationArtifactId ?? null;
  const managedServing = selectedVersion?.lineage.managedServing ?? null;
  const selectedPlan =
    selectedVersion?.plan ??
    (selectedJob ? planById.get(selectedJob.planId) ?? null : null);
  const selectedTaskset =
    selectedVersion?.taskset ??
    labModelTasksets(state).find(
      (taskset) =>
        taskset.id ===
        (selectedLifecycleRun?.taskset.id ?? selectedPlan?.tasksetId)
    ) ??
    null;
  const detail = useTrainingRunDetail(
    connection,
    selectedJob?.id ?? null,
    selectedJob?.status ?? null
  );
  const receipts = selectedJob
    ? state?.rolloutReceipts.filter(
        (receipt) => receipt.jobId === selectedJob.id
      ) ?? []
    : [];
  const hasStepMetrics = Boolean(
    detail.detail?.stepMetrics.length || detail.detail?.policyMetrics.length
  );
  useEffect(() => {
    setActiveRunTab("summary");
    onTabChange?.("summary");
  }, [onTabChange, selectedEntryKey]);

  if (!selectedEntry && !selectedLifecycleRun) {
    return (
      <div className="labs-model-version-detail">
        <div className="training-run-placeholder">
          This training attempt is no longer available.
        </div>
      </div>
    );
  }

  return (
    <div className="labs-model-version-detail">
      <div
        className="training-detail-tabs"
        role="tablist"
        aria-label="Run detail"
      >
        {(
          [
            ["summary", "Summary"],
            ["metrics", "Metrics"],
            ["evals", "Evals"],
            ["artifacts", "Artifacts"],
            ["logs", "Logs"],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-selected={activeRunTab === id}
            className={activeRunTab === id ? "active" : undefined}
            key={id}
            role="tab"
            type="button"
            onClick={() => {
              setActiveRunTab(id);
              onTabChange?.(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeRunTab === "summary" ? (
        <LabModelRunSummary
          baseModel={baseModelName(selectedPlan, selectedBaseModelId)}
          compute={
            selectedLifecycleRun
              ? destinationLabel(selectedLifecycleRun.destinationId)
              : selectedPlan
              ? destinationLabel(selectedPlan.destinationId)
              : selectedJob
              ? destinationLabel(selectedJob.destinationId)
              : "Not recorded"
          }
          duration={
            selectedLifecycleRun
              ? formatDuration(
                  selectedLifecycleRun.startedAt,
                  selectedLifecycleRun.completedAt
                )
              : selectedJob
              ? formatDuration(selectedJob.startedAt, selectedJob.completedAt)
              : "Not recorded"
          }
          failure={selectedJob?.error ?? selectedLifecycleRun?.failure ?? null}
          method={trainingMethodLabel(
            selectedLifecycleRun?.method ?? selectedPlan?.recipe.method
          )}
          output={
            selectedVersion ? `Version ${selectedVersion.number}` : "No Version"
          }
          reward={selectedLifecycleRun?.reward?.raw ?? null}
          status={
            selectedLifecycleRun
              ? statusLabel(selectedLifecycleRun.status)
              : selectedJob
              ? statusLabel(selectedJob.status)
              : "Imported"
          }
          statusValue={
            selectedLifecycleRun?.status ?? selectedJob?.status ?? "imported"
          }
          taskset={selectedTaskset?.name ?? "Unavailable"}
          telemetry={selectedLifecycleRun?.receipt?.telemetry ?? null}
          title={
            selectedLifecycleRun || selectedJob
              ? selectedRunNumber
                ? `Run ${selectedRunNumber}`
                : "Run details"
              : selectedVersion
              ? `Version ${selectedVersion.number}`
              : "Run details"
          }
          versionStatus={
            selectedVersion
              ? selectedVersion.current
                ? "Active"
                : "Available"
              : "Not created"
          }
          onOpenTaskset={
            selectedTaskset
              ? () => onOpenDataset(selectedTaskset.id)
              : undefined
          }
        />
      ) : null}

      {activeRunTab === "metrics" ? (
        <>
          <DetailSection
            title={
              (selectedLifecycleRun?.method ?? selectedPlan?.recipe.method) ===
              "grpo"
                ? "Rollout scores"
                : "Training metrics"
            }
          >
            {selectedJob &&
            (detail.loading || hasStepMetrics || !selectedLifecycleRun) ? (
              <TrainingRunMetrics
                detail={detail.detail}
                error={detail.error}
                loading={detail.loading}
              />
            ) : selectedLifecycleRun ? (
              <LabLifecycleRunMetrics run={selectedLifecycleRun} />
            ) : selectedJob ? (
              <TrainingRunMetrics
                detail={detail.detail}
                error={detail.error}
                loading={detail.loading}
              />
            ) : (
              <div className="training-run-placeholder">
                Metrics were not recorded for this imported Version.
              </div>
            )}
          </DetailSection>
          {(selectedLifecycleRun?.method ?? selectedPlan?.recipe.method) ===
          "grpo" ? (
            <DetailSection title="Rollout traces">
              <TrainingRolloutReceipts receipts={receipts} />
            </DetailSection>
          ) : null}
        </>
      ) : null}

      {activeRunTab === "evals" ? (
        <>
          <DetailSection title="Product-quality evaluation">
            <div className="training-run-evaluation">
              <TrainingRunEvaluation
                detail={detail.detail}
                loading={detail.loading}
              />
              {selectedEvaluationArtifactId ? (
                <button
                  className="training-button secondary"
                  type="button"
                  onClick={() =>
                    void training.actions.downloadArtifact(
                      selectedEvaluationArtifactId
                    )
                  }
                >
                  Download evaluation receipt
                </button>
              ) : null}
            </div>
          </DetailSection>
        </>
      ) : null}

      {activeRunTab === "artifacts" ? (
        <>
          <DetailSection title="Configuration and artifacts">
            <dl className="training-configuration-list">
              <Fact
                label="Training attempt"
                value={selectedJob?.id ?? "Provider import"}
              />
              <Fact
                label="Taskset"
                value={selectedTaskset?.name ?? "Unavailable"}
              />
              <Fact
                label="Prepared data"
                value={selectedJob?.bundleHash ?? "Provider managed"}
              />
              <Fact
                label="Version ID"
                value={selectedVersion?.lineage.id ?? "No Version created"}
              />
            </dl>
          </DetailSection>
          <ManagedAdapterServingStatus projection={managedServing} />
        </>
      ) : null}

      {activeRunTab === "logs" ? (
        selectedJob ? (
          <TrainingEventLog
            error={selectedJob.error ?? detail.error}
            events={detail.detail?.events ?? []}
            loading={detail.loading}
          />
        ) : (
          <div className="training-run-placeholder">
            No run log entries yet.
          </div>
        )
      ) : null}
    </div>
  );
}

function baseModelName(
  plan: ReturnType<typeof labModelPlans>[number] | null,
  fallback: string | null = null
) {
  if (!plan) return fallback ? modelRefName(fallback) : "Not recorded";
  const model =
    plan.recipe.method === "sft" || plan.recipe.method === "grpo"
      ? plan.recipe.baseModel
      : plan.recipe.method === "dpo"
      ? plan.recipe.policyModel
      : plan.recipe.method === "ppo"
      ? plan.recipe.policyOptimization.policyModel
      : null;
  return model ? modelRefName(model.id) : "Not recorded";
}

function modelRefName(modelId: string) {
  return modelId.split("/").at(-1) ?? modelId;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ManagedAdapterServingStatus({
  projection,
}: {
  projection: ManagedAdapterServingProjection | null;
}) {
  if (!projection) return null;
  return (
    <DetailSection title="Serving readiness">
      <dl className="labs-inline-facts">
        <Fact
          label="Admission"
          value={projection.customerBindingAllowed ? "Allowed" : "Pending"}
        />
        <Fact
          label="Artifact"
          value={managedStateLabel(projection.canonicalArtifactState)}
        />
        <Fact
          label="Deployment"
          value={managedStateLabel(projection.canonicalDeploymentState)}
        />
        <Fact
          label="Base profile"
          value={projection.baseProfileId ?? "Pending"}
        />
        <Fact
          label="Last synchronized"
          value={formatDateTime(projection.lastSyncedAt)}
        />
        {projection.lastError ? (
          <Fact label="Synchronization" value={projection.lastError} />
        ) : null}
      </dl>
    </DetailSection>
  );
}

function managedStateLabel(value: string | null): string {
  return value
    ? value
        .replaceAll("_", " ")
        .replace(/^./, (character) => character.toUpperCase())
    : "Pending";
}

function TrainingEventLog({
  error,
  events,
  loading,
}: {
  error: string | null;
  events: TrainingJobEvent[];
  loading: boolean;
}) {
  if (loading && !events.length) {
    return <div className="training-run-placeholder">Loading run events…</div>;
  }
  if (!events.length) {
    return (
      <div className="training-run-placeholder">
        {error ?? "No normalized run events were recorded."}
      </div>
    );
  }
  return (
    <div className="training-table-wrap">
      <table className="training-data-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatDateTime(event.timestamp)}</td>
              <td>{eventLabel(event.type)}</td>
              <td>{eventSummary(event)}</td>
            </tr>
          ))}
          {error ? (
            <tr>
              <td>—</td>
              <td>Failure</td>
              <td>{error}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function eventLabel(type: TrainingJobEvent["type"]): string {
  return type
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

function eventSummary(event: TrainingJobEvent): string {
  const payload = event.payload;
  const step = finiteNumber(payload.step);
  const maxSteps = finiteNumber(payload.maxSteps);
  if (event.type === "start") {
    return typeof payload.device === "string"
      ? `Worker started on ${payload.device}.`
      : "Worker started.";
  }
  if (event.type === "progress" && step != null) {
    return maxSteps == null ? `Step ${step}.` : `Step ${step} of ${maxSteps}.`;
  }
  if (event.type === "metric") {
    const kind =
      typeof payload.metricKind === "string"
        ? payload.metricKind.replaceAll("_", " ")
        : "metric";
    const values = [
      numericSummary("loss", payload.loss),
      numericSummary("reward", payload.meanReward ?? payload.reward),
      numericSummary("policy loss", payload.policyLoss),
      numericSummary("value loss", payload.valueLoss),
      numericSummary(
        "preference accuracy",
        payload.preferenceAccuracy,
        percentValue
      ),
    ].filter((value): value is string => Boolean(value));
    return `${kind}${step == null ? "" : ` · step ${step}`}${
      values.length ? ` · ${values.join(" · ")}` : ""
    }`;
  }
  if (event.type === "complete") {
    const artifactCount = finiteNumber(payload.artifactCount);
    return artifactCount == null
      ? "Worker completed."
      : `Worker completed with ${artifactCount} artifacts.`;
  }
  if (event.type === "failure" && typeof payload.message === "string") {
    return payload.message;
  }
  return Object.keys(payload).length ? JSON.stringify(payload) : "Recorded.";
}

function numericSummary(
  label: string,
  value: unknown,
  format: (value: number) => string = (number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
      number
    )
): string | null {
  const number = finiteNumber(value);
  return number == null ? null : `${label} ${format(number)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentValue(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
