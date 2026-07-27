import { useEffect, useMemo, useState } from "react";
import {
  resolveModelBindingPromotionGate,
  type ManagedAdapterServingProjection,
  type TrainingJobEvent,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import { Download, MessageSquare } from "../icons";
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
import {
  labModelBaselineRuns,
  labModelJobs,
  labModelPlans,
  labModelTasksets,
  labModelVersions,
} from "./lab-models";
import {
  baselineRunStatusLabel,
  isActiveBaselineRun,
  modelVersionEntries,
  type ModelWorkspaceProps,
} from "./LabModelWorkspace";

export function LabModelVersionDetailPage({
  connection,
  selectedEntryKey,
  workproduct,
  runs,
  training,
  onBack,
  onOpenDataset,
  onTabChange,
  onUseVersion,
  readOnly = false,
}: ModelWorkspaceProps & {
  connection: ClientConnection | null;
  selectedEntryKey: string;
  onBack: () => void;
  onTabChange?: (
    tab: "summary" | "metrics" | "evals" | "artifacts" | "logs"
  ) => void;
  onUseVersion: (versionId: string) => void;
  readOnly?: boolean;
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
  const baselineRuns = useMemo(
    () => labModelBaselineRuns(workproduct, runs, state),
    [runs, state, workproduct]
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
    () => modelVersionEntries(jobs, versions, baselineRuns),
    [baselineRuns, jobs, versions]
  );
  const selected =
    entries.find((entry) => entry.key === selectedEntryKey) ?? null;
  const selectedJob = selected?.job ?? null;
  const selectedVersion = selected?.version ?? null;
  const selectedLifecycleRun = selectedJob
    ? state?.modelRuns.find(
        (run) => run.id === selectedJob.metadata.modelRunId
      ) ?? null
    : null;
  const selectedEvaluationArtifactId =
    selectedVersion?.lineage.frozenEvaluationArtifactId ?? null;
  const managedServing = selectedVersion?.lineage.managedServing ?? null;
  const selectedBaselineRun = selected?.baselineRun ?? null;
  const selectedPlan =
    selectedVersion?.plan ??
    (selectedJob ? planById.get(selectedJob.planId) ?? null : null);
  const selectedTaskset =
    selectedVersion?.taskset ??
    labModelTasksets(state).find(
      (taskset) =>
        taskset.id ===
        (selectedBaselineRun?.tasksetId ?? selectedPlan?.tasksetId)
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
  useEffect(() => {
    setActiveRunTab("summary");
    onTabChange?.("summary");
  }, [onTabChange, selectedEntryKey]);

  if (!selected) {
    return (
      <div className="labs-model-version-detail">
        <button
          className="settings-secondary compact"
          type="button"
          onClick={onBack}
        >
          Back to runs
        </button>
        <div className="training-run-placeholder">
          This training attempt is no longer available.
        </div>
      </div>
    );
  }

  return (
    <div className="labs-model-version-detail">
      <button
        className="settings-secondary compact labs-model-version-back"
        type="button"
        onClick={onBack}
      >
        Back to runs
      </button>

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
        <DetailSection
          title={
            selectedBaselineRun
              ? selectedBaselineRun.configuration.split === "train"
                ? "Train-signal check"
                : "Base-model check"
              : selectedVersion
              ? `Version ${selectedVersion.number}`
              : `${trainingMethodLabel(selectedPlan?.recipe.method)} attempt`
          }
          actions={
            selectedBaselineRun && isActiveBaselineRun(selectedBaselineRun) ? (
              <button
                className="training-button secondary"
                type="button"
                onClick={() =>
                  void training.actions.cancelBaselineRun(
                    selectedBaselineRun.id
                  )
                }
              >
                Cancel check
              </button>
            ) : selectedVersion ? (
              <div className="training-table-actions">
                {selectedTaskset ? (
                  <button
                    className="training-button secondary"
                    disabled={
                      readOnly ||
                      !resolveModelBindingPromotionGate(selectedVersion.lineage)
                    }
                    title={
                      resolveModelBindingPromotionGate(selectedVersion.lineage)
                        ? "Chat with this Version"
                        : "Chat is unavailable because this Version did not pass evaluation."
                    }
                    type="button"
                    onClick={() => onUseVersion(selectedVersion.lineage.id)}
                  >
                    <MessageSquare size={14} />
                    Chat
                  </button>
                ) : null}
                <button
                  className="training-button secondary"
                  type="button"
                  onClick={() =>
                    void training.actions.downloadModelPackage(
                      selectedVersion.lineage.id
                    )
                  }
                >
                  <Download size={14} />
                  Download LoRA
                </button>
              </div>
            ) : null
          }
        >
          <dl className="labs-inline-facts">
            <Fact
              label={selectedBaselineRun ? "Check status" : "Training status"}
              value={
                selectedBaselineRun
                  ? baselineRunStatusLabel(selectedBaselineRun)
                  : selectedJob
                  ? statusLabel(selectedJob.status)
                  : "Imported"
              }
            />
            <Fact
              label="Version status"
              value={
                selectedVersion
                  ? selectedVersion.current
                    ? "Active"
                    : "Available"
                  : "Not created"
              }
            />
            <Fact
              label="Training"
              value={
                selectedBaselineRun
                  ? "RFT readiness check"
                  : trainingMethodLabel(selectedPlan?.recipe.method)
              }
            />
            <Fact
              label="Base model"
              value={
                selectedBaselineRun
                  ? modelRefName(
                      selectedBaselineRun.configuration.model.modelId
                    )
                  : baseModelName(selectedPlan)
              }
            />
            <Fact
              label="Taskset"
              value={selectedTaskset?.name ?? "Unavailable"}
            />
            <Fact
              label="Compute"
              value={
                selectedBaselineRun
                  ? "Fireworks"
                  : selectedPlan
                  ? destinationLabel(selectedPlan.destinationId)
                  : selectedJob
                  ? destinationLabel(selectedJob.destinationId)
                  : "Not recorded"
              }
            />
            <Fact
              label="Duration"
              value={
                selectedBaselineRun
                  ? formatDuration(
                      selectedBaselineRun.startedAt,
                      selectedBaselineRun.completedAt
                    )
                  : selectedJob
                  ? formatDuration(
                      selectedJob.startedAt,
                      selectedJob.completedAt
                    )
                  : "Not recorded"
              }
            />
            <Fact
              label="Output"
              value={
                selectedVersion
                  ? `Version ${selectedVersion.number}`
                  : selectedBaselineRun?.reportId
                  ? "Check report"
                  : "No Version"
              }
            />
          </dl>
          {selectedTaskset ? (
            <button
              className="labs-version-dataset-link labs-version-detail-dataset"
              type="button"
              onClick={() => onOpenDataset(selectedTaskset.id)}
            >
              Open {selectedTaskset.name}
            </button>
          ) : null}
          {selectedBaselineRun?.error || selectedJob?.error ? (
            <p className="labs-training-error">
              {selectedBaselineRun?.error ?? selectedJob?.error}
            </p>
          ) : null}
          {selectedLifecycleRun?.receipt?.telemetry ? (
            <div className="training-run-evaluation">
              <div className="training-evaluation-facts">
                <Fact
                  label="GPU"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.resource.gpuCount ??
                    0
                  } × ${
                    selectedLifecycleRun.receipt.telemetry.resource.gpuType ??
                    "unreported"
                  }`}
                />
                <Fact
                  label="Tokens"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage.promptTokens ??
                    0
                  } prompt · ${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .generatedTokens ?? 0
                  } generated`}
                />
                <Fact
                  label="Trajectories"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .successfulTrajectories ?? 0
                  } succeeded · ${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .failedTrajectories ?? 0
                  } failed`}
                />
                <Fact
                  label="GPU time"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage.gpuSeconds?.toFixed(
                      1
                    ) ?? "0.0"
                  } seconds`}
                />
                <Fact
                  label={
                    selectedLifecycleRun.receipt.telemetry.cost
                      .providerReportedUsd === null
                      ? "Estimated cost"
                      : "Provider-reported cost"
                  }
                  value={`$${(
                    selectedLifecycleRun.receipt.telemetry.cost
                      .providerReportedUsd ??
                    selectedLifecycleRun.receipt.telemetry.cost.estimatedUsd ??
                    0
                  ).toFixed(4)}`}
                />
                <Fact
                  label="Optimizer"
                  value={`${
                    selectedLifecycleRun.receipt.telemetry.usage
                      .optimizerSteps ?? 0
                  } step`}
                />
              </div>
              <button
                className="training-button secondary"
                type="button"
                onClick={() =>
                  downloadCanonicalJson(
                    `${selectedLifecycleRun.id}-receipt.json`,
                    selectedLifecycleRun.receipt
                  )
                }
              >
                <Download size={14} />
                Download Model Run receipt
              </button>
            </div>
          ) : null}
        </DetailSection>
      ) : null}
      {activeRunTab === "summary" ? (
        <ManagedAdapterServingStatus projection={managedServing} />
      ) : null}

      {selectedJob && activeRunTab === "metrics" ? (
        <>
          <DetailSection
            title={
              selectedPlan?.recipe.method === "grpo"
                ? "Rollout scores"
                : "Training metrics"
            }
          >
            <TrainingRunMetrics
              detail={detail.detail}
              error={detail.error}
              loading={detail.loading}
            />
          </DetailSection>
          {selectedPlan?.recipe.method === "grpo" ? (
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
        <DetailSection title="Configuration and artifacts">
          <dl className="training-configuration-list">
            <Fact
              label={selectedBaselineRun ? "Check run" : "Training attempt"}
              value={
                selectedBaselineRun?.id ?? selectedJob?.id ?? "Provider import"
              }
            />
            <Fact
              label="Taskset"
              value={selectedTaskset?.name ?? "Unavailable"}
            />
            <Fact
              label={selectedBaselineRun ? "Selection" : "Prepared data"}
              value={
                selectedBaselineRun
                  ? `${selectedBaselineRun.configuration.taskLimit} prompts × ${selectedBaselineRun.configuration.attemptsPerTask} attempts`
                  : selectedJob?.bundleHash ?? "Provider managed"
              }
            />
            <Fact
              label={selectedBaselineRun ? "Provider deployment" : "Version ID"}
              value={
                selectedBaselineRun
                  ? selectedBaselineRun.provider?.deploymentId ??
                    "Not provisioned"
                  : selectedVersion?.lineage.id ?? "No Version created"
              }
            />
            {selectedBaselineRun ? (
              <Fact
                label="Attempt progress"
                value={`${selectedBaselineRun.progress.completedAttempts} of ${selectedBaselineRun.progress.totalAttempts}`}
              />
            ) : null}
            {selectedBaselineRun?.provider?.statusCode ? (
              <Fact
                label="Provider status"
                value={selectedBaselineRun.provider.statusCode}
              />
            ) : null}
          </dl>
        </DetailSection>
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
            {selectedBaselineRun?.error ?? "No run log entries yet."}
          </div>
        )
      ) : null}
    </div>
  );
}

function downloadCanonicalJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function baseModelName(plan: ReturnType<typeof labModelPlans>[number] | null) {
  if (!plan) return "Not recorded";
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
    <DetailSection title="Managed Sandbox serving">
      <p className="training-muted">
        Sandbox owns evaluation, provider operations, receipts, and costs.
        OpenPond retains only the binding and readiness state needed for Chat.
      </p>
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
