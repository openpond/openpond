import { useEffect, useState } from "react";
import { z } from "zod";
import { TrainingJobSchema, TrainingJobEventSchema, TrainingJobOutputsSchema } from "openpond-sdk/training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { statusLabel, formatDateTime } from "../training/training-model-data";
import "./model-training-journey.css";

const Detail = z.object({ job: TrainingJobSchema, events: z.array(TrainingJobEventSchema), outputs: TrainingJobOutputsSchema });
type Detail = z.infer<typeof Detail>;
const terminalStates = new Set(["completed", "succeeded", "failed", "cancelled", "budget_exhausted"]);
const stages = ["Prepare", "Baseline", "Rollouts", "Optimize", "Checkpoint", "Reload", "Evaluate", "Finish"];
const phaseIndex: Record<string, number> = { draft: 0, validating: 0, admitted: 0, admitting: 0, queued: 0, provisioning: 0, provisioning_gpu: 0, provisioning_rollouts: 0, warming: 0, rollout_phase: 2, draining: 2, update_phase: 3, reloading: 5, validating_checkpoints: 6, artifact_ready: 7, completed: 7, succeeded: 7 };

export function ModelTrainingJourney({ connection, teamId, projectId, jobId, onOpenRun }: {
  connection: ClientConnection; teamId: string; projectId: string; jobId: string; onOpenRun: () => void;
}) {
  const scope = JSON.stringify([connection.serverUrl, connection.token, teamId, projectId, jobId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; detail: Detail } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const detail = Detail.parse(await apiFetch(connection, `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}?teamId=${encodeURIComponent(teamId)}`, { signal: controller.signal }));
        if (detail.job.id !== jobId || detail.job.teamId !== teamId || detail.job.modelProjectId !== projectId) throw new Error("Run does not belong to this Model Project.");
        if (controller.signal.aborted) return;
        setSnapshot({ scope, detail }); setFailure(null);
        if (!terminalStates.has(detail.job.state)) timer = setTimeout(read, 5000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure({ scope, message: error instanceof Error ? error.message : "Run progress is unavailable." });
        timer = setTimeout(read, 10000);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [scope, connection.serverUrl, connection.token, teamId, projectId, jobId]);
  const detail = snapshot?.scope === scope ? snapshot.detail : null;
  const error = failure?.scope === scope ? failure.message : null;
  const job = detail?.job;
  const outputs = detail?.outputs.outputs ?? [];
  const qualification = job?.executionMode === "qualification";
  const progress = job?.rolloutProgress;
  const done = [false, outputs.some(o => o.kind === "evaluation" && o.metadata.kind === "baseline"), (progress?.groupsTarget ?? 0) > 0 && progress?.groupsCompleted === progress?.groupsTarget, (progress?.optimizerUpdatesApplied ?? 0) > 0, outputs.some(o => o.kind === "checkpoint" || o.kind === "adapter"), false, outputs.some(o => o.kind === "evaluation" && o.metadata.kind === "candidate"), job?.state === "succeeded"];
  // A later phase alone is not proof of a weight update, checkpoint, or reload.
  const events = detail?.events ?? [];
  // A committed step can be retained during cancellation without activating its policy.
  // This endpoint does not expose the serving attestation needed to verify reload.
  done[5] = false;
  const baselineRunning = job?.phase === "warming" && !qualification && !done[1] && events.some(event => event.type === "infer");
  const checkpointUploading = job?.phase === "update_phase" && events.some(event => event.type === "upload_checkpoint" && ["pending", "leased"].includes(event.phase));
  const latestRollout = [...events].reverse().find(event => event.type === "rollout_metric" && typeof event.data.rolloutGroupIndex === "number");
  const recordedGroup = latestRollout?.data.rolloutGroupIndex;
  const active = checkpointUploading ? 4 : baselineRunning ? 1 : job ? phaseIndex[job.phase] : undefined;
  done[0] = !!job && (active !== undefined && active > 0 || done[1] || done[2]);
  const terminal = !!job && terminalStates.has(job.state);
  const interrupted = terminal && !done[7];
  const latestEvent = detail?.events.at(-1);
  return <section className="model-journey" aria-label="Training run stages">
    <div className="model-journey-heading"><div><span className="model-journey-eyebrow">{qualification ? "Qualification run" : "Training journey"}</span><h3>{job ? checkpointUploading ? "Saving checkpoint" : baselineRunning ? "Baseline evaluation" : statusLabel(job.phase) : "Loading run progress…"}</h3></div><button className="training-button secondary" onClick={onOpenRun} type="button">View run</button></div>
    <div className="model-journey-track" role="list" aria-label="Run stages">
      {stages.map((label, index) => {
        const skipped = qualification && [1, 3, 4, 5, 6].includes(index);
        const current = active === index && !terminal && !skipped;
        const state = skipped ? "not-applicable" : current ? "active" : done[index] ? "complete" : interrupted && (active === index || index === 7) ? "stopped" : "pending";
        return <div className={`model-journey-stage ${state}`} role="listitem" key={label} aria-current={current ? "step" : undefined}>
          <svg className="model-journey-wire" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="M0 16 H100" /></svg>
          <span className="model-journey-node"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" />{done[index] && !skipped ? <path d="m10 16 4 4 8-8" /> : <text x="16" y="20" textAnchor="middle">{index + 1}</text>}</svg></span>
          <strong>{label}</strong><span>{skipped ? "Not applicable" : current ? error ? "Last known stage" : "In progress" : done[index] ? "Recorded" : state === "stopped" ? "Stopped" : index === 5 ? "Unverified" : terminal ? "Not recorded" : "Pending"}</span>
        </div>;
      })}
    </div>
    <div className="model-journey-facts" aria-live="polite"><span><b>{progress ? `${progress.groupsCompleted} / ${progress.groupsTarget}` : "—"}</b> groups complete{typeof recordedGroup === "number" ? ` · latest recorded group ${recordedGroup + 1}` : ""}</span><span><b>{progress?.optimizerUpdatesApplied ?? "—"}</b> weight updates</span><span><b>{progress?.optimizerUpdatesSkipped ?? "—"}</b> updates skipped</span><span>{job ? statusLabel(job.state) : "Connecting"}</span></div>
    <p className="model-journey-note">{error ? `Refresh unavailable: ${error}${detail ? " Showing last received evidence." : " No run evidence received yet."}` : job?.terminalReason ?? latestEvent?.message ?? "Stages update from recorded run events and artifacts."}</p>
    {job ? <p className="model-journey-time">Updated {formatDateTime(job.updatedAt)} · Stages reflect recorded evidence, not estimated progress.</p> : null}
  </section>;
}
