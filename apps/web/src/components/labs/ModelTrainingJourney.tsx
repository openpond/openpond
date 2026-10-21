import { ErrorToast } from "../common/ErrorToast";
import { useHostedTrainingRun } from "./use-hosted-training-run";
import type { ClientConnection } from "../../api/api-client";
import { statusLabel, formatDateTime } from "../training/training-model-data";
import "./model-training-journey.css";
import { TrainingMetricWorkbench } from "../training/TrainingMetricWorkbench";
import { hostedTrainingMetricSeries } from "../training/hosted-training-metrics";
import { ConsoleRunFlowDiagram, RunFlowDiagram } from "../training/RunFlowDiagram";
import { TrainingRolloutGroups } from "../training/TrainingRolloutGroups";
import { TrainingRecoveryLineage } from "../training/TrainingRecoveryLineage";
import { useState, type ComponentProps } from "react";
import { RunEvidenceContext } from "../training/RetainedRunFeedback";
import { DropdownSelect } from "../DropdownSelect";
import { RunInspectionContext, type RunEvidenceInspection } from "../training/RunEvidencePanel";
import { TrainingEvidenceWorkspace } from "../training/TrainingEvidenceWorkspace";
import { TrainingRunLineage, ContinualLearningStatus } from "../training/TrainingRunLineage";

export function ModelTrainingJourney(props: ComponentProps<typeof ModelTrainingJourneyContent>) {
  return <ModelTrainingJourneyContent key={`${props.teamId}:${props.jobId}`} {...props} />;
}

function ModelTrainingJourneyContent({
  connection,
  teamId,
  projectId,
  jobId,
  onOpenRun,
  compact = false,
  initialStatus,
}: {
  connection: ClientConnection;
  teamId: string;
  projectId: string;
  jobId: string;
  onOpenRun: () => void;
  compact?: boolean;
  initialStatus?: string;
}) {
  const [stage, setStage] = useState("Logs");
  const [groupIndex, setGroupIndex] = useState<number>();
  const [inspection, setInspection] = useState<RunEvidenceInspection | null>(null);
  const { detail, flow, summary, logs, logsLoading, logsError, error } = useHostedTrainingRun(
    connection,
    teamId,
    jobId,
    projectId,
    stage === "Logs",
  );
  const selectedGroup = flow?.groups.find((group) => group.index === groupIndex);
  const scopedFlow =
    flow && groupIndex !== undefined
      ? {
          ...flow,
          groups: selectedGroup ? [selectedGroup] : [],
          groupCount: selectedGroup ? 1 : 0,
          nodes: flow.nodes.map((node) => {
            if (!node.inLoop)
              return { ...node, detail: `Run-wide${node.detail ? ` · ${node.detail}` : ""}` };
            return (
              selectedGroup?.nodes?.find((item) => item.label === node.label) ?? {
                label: node.label,
                inLoop: true,
                state: "missing" as const,
                status: "Not recorded",
                detail: "No linked group evidence",
                diagnostics: [],
              }
            );
          }),
        }
      : flow;
  const selectEvidence = (next: RunEvidenceInspection) => {
    if (next.groupIndex !== undefined) setGroupIndex(next.groupIndex);
    setStage(next.title);
    setInspection(next.groupIndex !== undefined ? next : null);
  };
  const job = summary ?? detail?.job;
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
    flow?.nodes.find((node) => node.state === "active")?.label ??
    (flow && !flow.live
      ? statusLabel(flow.state)
      : job
        ? statusLabel(job.phase)
        : initialStatus
          ? statusLabel(initialStatus)
          : "Training journey");
  return (
    <RunEvidenceContext.Provider value={{ connection, teamId, jobId }}>
      <RunInspectionContext.Provider value={selectEvidence}>
        <section
          className={`model-journey ${compact ? "compact" : ""}`}
          aria-label="Training run stages"
        >
          <div className="model-journey-heading">
            <div>
              <span className="model-journey-eyebrow">
                {qualification ? "Qualification run" : "Training journey"}
              </span>
              <div className="model-journey-title-row">
                <h3>{headline}</h3>
                <TrainingRunLineage continuation={flow?.continuation} recovery={flow?.recovery} compact />
              </div>
            </div>
            <button className="training-button secondary" onClick={onOpenRun} type="button">
              View run
            </button>
          </div>
          {flow && scopedFlow ? (
            <>
              <DropdownSelect
                label="Training group context"
                value={groupIndex === undefined ? "all" : String(groupIndex)}
                options={[
                  { value: "all", label: "All groups · run overview" },
                  ...flow.groups.map((group) => ({
                    value: String(group.index),
                    label: `Group ${group.index + 1} · ${group.replay ? `Replay · ${group.state}` : group.inherited ? `Inherited · ${group.inherited.optimizerDisposition === "applied" ? "Update applied" : "Skipped · no signal"}` : group.optimizerDisposition === "skipped_no_signal" ? "Skipped · no signal" : group.state}`,
                  })),
                ]}
                onChange={(value) => {
                  setGroupIndex(value === "all" ? undefined : Number(value));
                  setInspection(null);
                }}
              />
              <p className="training-muted">
                {groupIndex === undefined
                  ? "Run overview · all retained groups"
                  : "Group scope · preparation and evaluations remain run-wide"}
              </p>
              <TrainingRecoveryLineage recovery={flow.recovery} />
              <FlowDiagram
                nodes={scopedFlow.nodes}
                continuation={flow.continuation}
                inference={flow.inference}
                live={flow.live && !error}
                loopLabel={qualification ? "Rollout + grading" : "Training loop"}
                groupLabel={
                  groupIndex === undefined
                    ? `group ${flow.groupsCompleted} of ${flow.groupsTarget}`
                    : `Group ${groupIndex + 1} snapshot`
                }
                policyLabel={
                  groupIndex === undefined
                    ? `policy v${flow.policyVersion}`
                    : `group ${groupIndex + 1}`
                }
              />
              <TrainingRolloutGroups evidence={{ ...scopedFlow, live: flow.live && !error }} />
            </>
          ) : detail?.flowError ? (
            <ErrorToast error={detail.flowError} />
          ) : null}
          <div className="model-journey-facts" aria-live="polite">
            <span>
              <b>
                {selectedGroup
                  ? `Group ${selectedGroup.index + 1}`
                  : progress
                    ? `${progress.groupsCompleted} / ${progress.groupsTarget}`
                    : "—"}
              </b>{" "}
              {selectedGroup ? selectedGroup.state : "groups complete"}
              {groupIndex === undefined && typeof recordedGroup === "number"
                ? ` · latest recorded group ${recordedGroup + 1}`
                : ""}
            </span>
            <span>
              <b>
                {selectedGroup
                  ? (selectedGroup.nodes?.find((node) => node.label === "Update adapter")?.detail ??
                    "No linked optimizer evidence")
                  : progress
                    ? Math.max(
                        0,
                        progress.optimizerUpdatesApplied - (flow?.recovery?.optimizerUpdatesApplied ?? 0),
                      )
                    : "—"}
              </b>{" "}
              {selectedGroup ? "optimizer outcome" : flow?.recovery ? "new weight updates" : "weight updates"}
            </span>
            <span>
              <b>{progress?.optimizerUpdatesSkipped ?? "—"}</b> run-wide updates skipped
            </span>
            <span>
              {job ? statusLabel(job.state) : "Connecting"}
              <small className="training-continual-status">
                <ContinualLearningStatus enabled={flow ? !!flow.continuation : undefined} />
                {flow?.recovery ? <span> · Checkpoint recovery</span> : null}
              </small>
            </span>
          </div>
          <ErrorToast error={error} />
          <p className="model-journey-note">
            {error
              ? detail || summary || flow
                ? "Showing last received evidence."
                : "No run evidence received yet."
              : (job?.terminalReason ??
                latestEvent?.message ??
                "Stages update from recorded run events and artifacts.")}
          </p>
          {job ? (
            <p className="model-journey-time">
              Updated {formatDateTime(job.updatedAt)} · Stages reflect recorded evidence, not
              estimated progress.
            </p>
          ) : null}
          {compact && detail ? (
            <TrainingMetricWorkbench
              series={hostedTrainingMetricSeries(
                groupIndex === undefined
                  ? detail.events
                  : detail.events.filter((event) => event.data.rolloutGroupIndex === groupIndex),
              )}
            />
          ) : null}
          {scopedFlow ? (
            <TrainingEvidenceWorkspace
              evidence={scopedFlow}
              stage={stage}
              groupIndex={groupIndex}
              inspection={inspection}
              onStage={(next) => {
                setStage(next);
                setInspection(null);
              }}
              logs={logs}
              logsLoading={logsLoading}
              logsError={logsError}
            />
          ) : null}
        </section>
      </RunInspectionContext.Provider>
    </RunEvidenceContext.Provider>
  );
}
