import { useMemo } from "react";
import {
  managedAdapterCustomerBindingAllowed,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import type { ClientConnection } from "../../api";
import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";
import { TrainingRunMetrics } from "../training/TrainingRunMetrics";
import {
  formatDateTime,
  statusLabel,
  trainingMethodLabel,
} from "../training/training-model-data";
import { useTrainingRunDetail } from "../training/useTrainingRunDetail";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  labBaseModelVersion,
  labLifecycleModelRuns,
  labModelJobs,
  labModelTasksets,
  labModelVersions,
} from "./lab-models";
import { modelRunEntries, type ModelWorkspaceProps } from "./LabModelWorkspace";

type TrainingController = ReturnType<typeof useTraining>;

export function LabModelOverview({
  connection,
  workproduct,
  runs,
  training,
  onOpenEntry,
}: Omit<ModelWorkspaceProps, "onOpenDataset"> & {
  connection: ClientConnection | null;
  training: TrainingController;
  onOpenEntry: (entryKey: string) => void;
}) {
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
  const runEntries = useMemo(
    () => modelRunEntries(jobs, versions, lifecycleRuns),
    [jobs, lifecycleRuns, versions]
  );
  const metricEntry =
    runEntries.find(
      (entry) =>
        entry.job?.status === "succeeded" ||
        entry.lifecycleRun?.status === "succeeded"
    ) ?? null;
  const metricJob = metricEntry?.job ?? null;
  const detail = useTrainingRunDetail(
    connection,
    metricJob?.id ?? null,
    metricJob?.status ?? null
  );
  const currentVersion = versions.find((version) => version.current) ?? null;
  const latestRun = runEntries[0] ?? null;
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
  const evaluation = versionEvaluation(
    currentVersion,
    workproduct.evaluationStatus
  );
  const rewardPoints = useMemo(
    () =>
      [...lifecycleRuns]
        .filter((run) => run.reward !== null)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .map((run, index) => ({
          run: index + 1,
          value: run.reward!.raw,
        })),
    [lifecycleRuns]
  );

  return (
    <div className="labs-model-overview">
      <section className="labs-model-kpi-grid" aria-label="Model summary">
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
          value={String(runEntries.length)}
          supporting={`${versions.length} trained ${
            versions.length === 1 ? "Version" : "Versions"
          }`}
        />
      </section>

      <DetailSection
        title="Latest performance"
        actions={
          metricEntry ? (
            <button
              className="settings-secondary compact"
              type="button"
              onClick={() => onOpenEntry(metricEntry.key)}
            >
              View run
            </button>
          ) : null
        }
      >
        {metricJob ? (
          <TrainingRunMetrics
            detail={detail.detail}
            error={detail.error}
            loading={detail.loading}
          />
        ) : rewardPoints.length ? (
          <ModelRewardChart points={rewardPoints} />
        ) : (
          <div className="labs-model-empty-panel">
            <strong>No performance data yet</strong>
            <span>
              Metrics from the latest successful training run will appear here.
            </span>
          </div>
        )}
      </DetailSection>

      <div className="labs-model-overview-columns">
        <DetailSection title="Model details">
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

        <DetailSection title="Latest activity">
          {latestRun ? (
            <button
              className="labs-model-latest-run"
              type="button"
              onClick={() => onOpenEntry(latestRun.key)}
            >
              <span>
                <strong>Run {runEntries.length}</strong>
                <small>
                  {`${trainingMethodLabel(
                    latestRun.lifecycleRun?.method ??
                      latestRun.version?.plan?.recipe.method
                  )} · ${formatDateTime(
                    latestRun.lifecycleRun?.updatedAt ??
                      latestRun.job?.updatedAt ??
                      ""
                  )}`}
                </small>
              </span>
              <LabStatusBadge
                label={statusLabel(
                  latestRun.lifecycleRun?.status ??
                    latestRun.job?.status ??
                    "not_run"
                )}
                value={
                  latestRun.lifecycleRun?.status ??
                  latestRun.job?.status ??
                  "not_run"
                }
              />
            </button>
          ) : (
            <div className="training-run-placeholder">No run activity yet.</div>
          )}
        </DetailSection>
      </div>
    </div>
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
  workproductStatus: "not_run" | "passed" | "failed"
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

function ModelRewardChart({
  points,
}: {
  points: Array<{ run: number; value: number }>;
}) {
  const width = 760;
  const height = 270;
  const padding = { top: 20, right: 20, bottom: 58, left: 64 };
  const values = points.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.max(Math.abs(rawMax) * 0.1, 0.1);
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;
  const firstRun = points[0]?.run ?? 1;
  const lastRun = points.at(-1)?.run ?? firstRun;
  const runSpan = Math.max(1, lastRun - firstRun);
  const x = (run: number) =>
    padding.left +
    ((run - firstRun) / runSpan) * (width - padding.left - padding.right);
  const y = (value: number) =>
    padding.top +
    ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const path = points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${x(point.run).toFixed(2)},${y(
          point.value
        ).toFixed(2)}`
    )
    .join(" ");

  return (
    <div className="training-run-metrics">
      <div className="training-metric-summary">
        <MetricFact label="Scored runs" value={String(points.length)} />
        <MetricFact
          label="Latest reward"
          value={points.at(-1)?.value.toFixed(3) ?? "—"}
        />
        <MetricFact
          label="Best reward"
          value={Math.max(...values).toFixed(3)}
        />
        <MetricFact label="Metric" value="Reward" />
      </div>
      <figure className="training-line-chart" aria-label="Reward by scored run">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="model-reward-chart"
        >
          <title id="model-reward-chart">Reward by scored run</title>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const lineY =
              padding.top + ratio * (height - padding.top - padding.bottom);
            const value = max - ratio * (max - min);
            return (
              <g key={ratio}>
                <line
                  className="training-chart-grid"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={lineY}
                  y2={lineY}
                />
                <text
                  className="training-chart-label"
                  x={padding.left - 10}
                  y={lineY + 4}
                  textAnchor="end"
                >
                  {value.toFixed(3)}
                </text>
              </g>
            );
          })}
          <line
            className="training-chart-axis"
            x1={padding.left}
            x2={width - padding.right}
            y1={height - padding.bottom}
            y2={height - padding.bottom}
          />
          {points.length > 1 ? (
            <path className="training-chart-line" d={path} />
          ) : null}
          {points.map((point) => (
            <circle
              key={`${point.run}-${point.value}`}
              className="training-chart-point"
              cx={x(point.run)}
              cy={y(point.value)}
              r="3"
            >
              <title>{`Scored run ${point.run}: ${point.value.toFixed(
                3
              )}`}</title>
            </circle>
          ))}
          <text
            className="training-chart-label"
            x={padding.left}
            y={height - 34}
            textAnchor="middle"
          >
            {firstRun}
          </text>
          <text
            className="training-chart-label"
            x={width - padding.right}
            y={height - 34}
            textAnchor="middle"
          >
            {lastRun}
          </text>
          <text
            className="training-chart-label axis-title"
            x={(padding.left + width - padding.right) / 2}
            y={height - 9}
            textAnchor="middle"
          >
            Scored run
          </text>
        </svg>
      </figure>
    </div>
  );
}

function MetricFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
