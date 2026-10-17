import { ErrorToast } from "../common/ErrorToast";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  TrainingJobSchema,
  TrainingJobEventSchema,
  TrainingJobOutputsSchema,
} from "openpond-sdk/training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { statusLabel, formatDateTime } from "../training/training-model-data";
import "./model-training-journey.css";
import { TrainingMetricWorkbench } from "../training/TrainingMetricWorkbench";
import { hostedTrainingMetricSeries } from "../training/hosted-training-metrics";
import { RunStageEvidenceSchema } from "@openpond/contracts";
import { ConsoleRunFlowDiagram, RunFlowDiagram } from "../training/RunFlowDiagram";
import { TrainingRolloutGroups } from "../training/TrainingRolloutGroups";
import { TrainingRecoveryLineage } from "../training/TrainingRecoveryLineage";

const Detail = z.object({
  job: TrainingJobSchema,
  events: z.array(TrainingJobEventSchema),
  outputs: TrainingJobOutputsSchema,
  flow: RunStageEvidenceSchema.nullable(),
  flowError: z.string().nullable(),
});
type Detail = z.infer<typeof Detail>;
const terminalStates = new Set([
  "completed",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
]);

export function ModelTrainingJourney({
  connection,
  teamId,
  projectId,
  jobId,
  onOpenRun,
  compact = false,
}: {
  connection: ClientConnection;
  teamId: string;
  projectId: string;
  jobId: string;
  onOpenRun: () => void;
  compact?: boolean;
}) {
  const scope = JSON.stringify([connection.serverUrl, connection.token, teamId, projectId, jobId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; detail: Detail } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const detail = Detail.parse(
          await apiFetch(
            connection,
            `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}?teamId=${encodeURIComponent(teamId)}`,
            { signal: controller.signal },
          ),
        );
        if (
          detail.job.id !== jobId ||
          detail.job.teamId !== teamId ||
          detail.job.modelProjectId !== projectId
        )
          throw new Error("Run does not belong to this Model Project.");
        if (controller.signal.aborted) return;
        setSnapshot({ scope, detail });
        setFailure(null);
        if (!terminalStates.has(detail.job.state) || detail.flowError)
          timer = setTimeout(read, 5000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure({
          scope,
          message: error instanceof Error ? error.message : "Run progress is unavailable.",
        });
        timer = setTimeout(read, 10000);
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [scope, connection.serverUrl, connection.token, teamId, projectId, jobId]);
  const detail = snapshot?.scope === scope ? snapshot.detail : null;
  const error = failure?.scope === scope ? failure.message : null;
  const job = detail?.job;
  const qualification = job?.executionMode === "qualification";
  const progress = job?.rolloutProgress;
  const events = detail?.events ?? [];
  const latestRollout = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "rollout_metric" && typeof event.data.rolloutGroupIndex === "number",
    );
  const recordedGroup = latestRollout?.data.rolloutGroupIndex;
  const latestEvent = detail?.events.at(-1);
  const FlowDiagram = compact ? RunFlowDiagram : ConsoleRunFlowDiagram;
  const headline =
    detail?.flow?.nodes.find((node) => node.state === "active")?.label ??
    (detail?.flow && !detail.flow.live
      ? statusLabel(detail.flow.state)
      : job
        ? statusLabel(job.phase)
        : "Loading run progress…");
  return (
    <section
      className={`model-journey ${compact ? "compact" : ""}`}
      aria-label="Training run stages"
    >
      <div className="model-journey-heading">
        <div>
          <span className="model-journey-eyebrow">
            {qualification ? "Qualification run" : "Training journey"}
          </span>
          <h3>{headline}</h3>
        </div>
        <button className="training-button secondary" onClick={onOpenRun} type="button">
          View run
        </button>
      </div>
      {detail?.flow ? (
        <>
          <TrainingRecoveryLineage recovery={detail.flow.recovery} />
          <FlowDiagram
            nodes={detail.flow.nodes}
            inference={detail.flow.inference}
            live={detail.flow.live && !error}
            loopLabel={qualification ? "Rollout + grading" : "Training loop"}
            groupLabel={`group ${detail.flow.groupsCompleted} of ${detail.flow.groupsTarget}`}
            policyLabel={`policy v${detail.flow.policyVersion}`}
          />
          <TrainingRolloutGroups evidence={{ ...detail.flow, live: detail.flow.live && !error }} />
        </>
      ) : detail?.flowError ? (
        <ErrorToast error={detail.flowError} />
      ) : null}
      <div className="model-journey-facts" aria-live="polite">
        <span>
          <b>{progress ? `${progress.groupsCompleted} / ${progress.groupsTarget}` : "—"}</b> groups
          complete
          {typeof recordedGroup === "number" ? ` · latest recorded group ${recordedGroup + 1}` : ""}
        </span>
        <span>
          <b>{progress ? Math.max(0, progress.optimizerUpdatesApplied - (detail?.flow?.recovery?.policyVersion ?? 0)) : "—"}</b> {detail?.flow?.recovery ? "new weight updates" : "weight updates"}
        </span>
        <span>
          <b>{progress?.optimizerUpdatesSkipped ?? "—"}</b> updates skipped
        </span>
        <span>{job ? statusLabel(job.state) : "Connecting"}</span>
      </div>
      <ErrorToast error={error} />
      <p className="model-journey-note">
        {error
          ? (detail ? "Showing last received evidence." : "No run evidence received yet.")
          : (job?.terminalReason ??
            latestEvent?.message ??
            "Stages update from recorded run events and artifacts.")}
      </p>
      {job ? (
        <p className="model-journey-time">
          Updated {formatDateTime(job.updatedAt)} · Stages reflect recorded evidence, not estimated
          progress.
        </p>
      ) : null}
      {compact && detail ? (
        <>
          <TrainingMetricWorkbench series={hostedTrainingMetricSeries(detail.events)} />
          <details className="dataset-workspace-logs">
            <summary>Training logs</summary>
            <ol>
              {detail.flow
                ? detail.flow.logs.map((entry, index) => (
                    <li key={`${entry.id}:${index}`}>
                      <time>{formatDateTime(entry.at)}</time>
                      <strong>{entry.source}</strong>
                      <span>{entry.message}</span>
                    </li>
                  ))
                : detail.events.slice(-100).map((event) => (
                    <li key={event.id}>
                      <time>{formatDateTime(event.createdAt)}</time>
                      <span>{event.message ?? statusLabel(event.type)}</span>
                    </li>
                  ))}
            </ol>
          </details>
        </>
      ) : null}
    </section>
  );
}
