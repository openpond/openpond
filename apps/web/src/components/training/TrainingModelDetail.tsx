import { useEffect, useMemo, useState } from "react";
import type { Taskset, TrainingDestinationId } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { Download } from "../icons";
import { TrainingModelConfiguration } from "./TrainingModelConfiguration";
import { TrainingRunEvaluation } from "./TrainingRunEvaluation";
import { TrainingRunMetrics } from "./TrainingRunMetrics";
import { TrainingStartDialog } from "./TrainingStartDialog";
import { artifactsForJob, destinationLabel, formatDateTime, formatDuration, jobsForTaskset, modelName, planForJob, statusLabel, tasksetMethod, trainingMethodLabel, trainingRunMethodLabel } from "./training-model-data";
import { useTrainingRunDetail } from "./useTrainingRunDetail";
import { DetailSection } from "./DetailSection";
import {
  TrainingModelComparisons,
  TrainingRolloutReceipts,
} from "./TrainingModelEvidence";
import { TrainingModelPromotion } from "./TrainingModelPromotion";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingModelDetail({
  taskset,
  training,
  connection,
  onDelete,
  onOpenTaskset,
  onOpenProviderSettings,
  onOpenTasksetFiles,
  onSelectedJobIdChange,
  onToast,
}: {
  taskset: Taskset;
  training: TrainingController;
  connection: ClientConnection | null;
  onDelete: () => void;
  onOpenTaskset: () => void;
  onOpenProviderSettings: () => void;
  onOpenTasksetFiles: () => void;
  onSelectedJobIdChange: (jobId: string | null) => void;
  onToast: ShowAppToast;
}) {
  const state = training.payload;
  const currentTaskset = state?.tasksets.find((candidate) =>
    candidate.id === taskset.id) ?? taskset;
  const jobs = useMemo(() => jobsForTaskset(state, taskset.id), [state, taskset.id]);
  const [selectedJobId, setSelectedJobId] = useState(jobs[0]?.id ?? null);
  const [tab, setTab] = useState<"summary" | "details" | "configuration" | "settings">("summary");
  const [startOpen, setStartOpen] = useState(false);
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const plan = planForJob(state, selectedJob);
  const artifacts = artifactsForJob(state, selectedJob?.id ?? null);
  const lineage = selectedJob ? state?.models.find((model) => model.jobId === selectedJob.id) ?? null : null;
  const modelLineage = state?.models
    .filter((model) => model.tasksetId === taskset.id && model.status === "imported")
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0] ?? null;
  const adapter = lineage ? state?.artifacts.find((artifact) => artifact.id === lineage.artifactId) ?? null : null;
  const detail = useTrainingRunDetail(connection, selectedJob?.id ?? null, selectedJob?.status ?? null);
  const method = tasksetMethod(taskset);
  const approvedTrainingExamples = taskset.datasetArtifact?.splitCounts.train
    ?? taskset.learningSignals.demonstrations.filter((demonstration) => demonstration.approved).length;
  const evaluationExamples = taskset.datasetArtifact?.splitCounts.frozen_eval
    ?? taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  const canStart = !selectedJob || ["succeeded", "failed", "cancelled"].includes(selectedJob.status);
  const trainingPath = taskset.readiness?.trainingPath ?? null;
  const selectedRunLabel = trainingRunMethodLabel(taskset, plan);
  const rolloutReceipts = state?.rolloutReceipts.filter((receipt) =>
    receipt.jobId === selectedJob?.id) ?? [];

  useEffect(() => { onSelectedJobIdChange(selectedJob?.id ?? null); }, [onSelectedJobIdChange, selectedJob?.id]);
  useEffect(() => () => onSelectedJobIdChange(null), [onSelectedJobIdChange]);

  return (
    <div className="training-model-detail">
      <header className="training-model-detail-header">
        <div>
          <h1>{modelName(taskset.name, method)}</h1>
          <span className="training-status-text">{selectedJob ? statusLabel(selectedJob.status) : taskset.readiness?.ready ? "Ready to train" : "Taskset needs review"}</span>
        </div>
      </header>

      <div className="training-detail-tabs" role="tablist" aria-label="Model detail">
        <button type="button" role="tab" aria-selected={tab === "summary"} className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>Summary</button>
        <button type="button" role="tab" aria-selected={tab === "details"} className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Details</button>
        <button type="button" role="tab" aria-selected={tab === "configuration"} className={tab === "configuration" ? "active" : ""} onClick={() => setTab("configuration")}>Configuration</button>
        <button type="button" role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
      </div>

      {tab === "summary" ? (
        <div className="training-detail-sections">
          <DetailSection title="Taskset" actions={<><button className="training-button secondary" type="button" onClick={onOpenTasksetFiles}>Open files</button>{!taskset.readiness?.ready ? <button className="training-text-button" type="button" onClick={onOpenTaskset}>Review Taskset</button> : null}</>}>
            <div className="training-taskset-facts"><span><strong>{approvedTrainingExamples}</strong> training examples</span><span><strong>{evaluationExamples}</strong> test examples</span><span><strong>{taskset.sourceRefs.length}</strong> dataset sources</span><span><strong>{trainingMethodLabel(method)}</strong> primary recommendation</span>{selectedJob ? <span><strong>{selectedRunLabel}</strong> selected run</span> : null}</div>
          </DetailSection>

          {trainingPath ? <DetailSection title="Training path">
            <div className="training-path-stages">
              <div><strong>Primary · {trainingMethodLabel(trainingPath.primaryMethod)}</strong><span>{stageCompatibility(trainingPath.primaryMethod, state?.destinations ?? [])}</span></div>
              {trainingPath.bootstrap ? <div><strong>Optional precursor · SFT trajectory bootstrap</strong><span>{stageCompatibility("sft", state?.destinations ?? [])}</span><small>{trainingPath.bootstrap.demonstrationRefs.length} approved trajectories · {trainingPath.bootstrap.limitations.join(" ")}</small></div> : null}
            </div>
          </DetailSection> : null}

          <DetailSection title="Model comparison">
            <TrainingModelComparisons taskset={taskset} state={state} />
          </DetailSection>

          <DetailSection title="Training runs" actions={canStart ? <button className="training-button" type="button" disabled={!taskset.readiness?.ready || Boolean(training.busyAction)} onClick={() => setStartOpen(true)}>Start training</button> : null}>
            {jobs.length ? <div className="training-table-wrap"><table className="training-data-table training-runs-table"><thead><tr><th>Run</th><th>Method</th><th>Compute</th><th>Started</th><th>Duration</th><th>Status</th></tr></thead><tbody>{jobs.map((job) => {
              const jobPlan = planForJob(state, job);
              return <tr key={job.id} className={job.id === selectedJob?.id ? "selected" : ""} onClick={() => setSelectedJobId(job.id)}><td><button type="button" onClick={() => setSelectedJobId(job.id)}>{shortId(job.id)}</button></td><td>{trainingRunMethodLabel(taskset, jobPlan)}</td><td>{jobPlan ? destinationLabel(jobPlan.destinationId) : job.destinationId}</td><td>{formatDateTime(job.startedAt ?? job.createdAt)}</td><td>{formatDuration(job.startedAt, job.completedAt)}</td><td><span className={`training-run-status ${job.status}`}>{statusLabel(job.status)}</span></td></tr>;
            })}</tbody></table></div> : <div className="training-run-placeholder">No training runs yet.</div>}
          </DetailSection>

          {selectedJob ? <>
            <DetailSection title="Training metrics"><TrainingRunMetrics detail={detail.detail} loading={detail.loading} error={detail.error}/></DetailSection>
            <DetailSection title="Evaluation"><TrainingRunEvaluation detail={detail.detail} loading={detail.loading}/></DetailSection>
            <DetailSection title="Result" actions={lineage && adapter ? <button className="training-button secondary" type="button" onClick={() => void training.actions.downloadModelPackage(lineage.id)}><Download size={14}/>Download LoRA package</button> : null}>
              <div className="training-result-summary"><strong>{lineage ? `${selectedRunLabel} adapter ready` : selectedJob.status === "succeeded" ? "Collecting adapter" : "No adapter created"}</strong>{adapter ? <span>{adapter.baseModelId} with LoRA</span> : null}{plan?.recipe.method === "sft" && method !== "sft" ? <span>Supervised bootstrap only; verifier reward was not optimized.</span> : null}{plan?.recipe.method === "grpo" ? <span>{Number(selectedJob.metadata.optimizerUpdatesObserved ?? 0)} optimizer updates observed in the provider receipt.</span> : null}{lineage ? <span>Frozen evaluation {lineage.frozenEvaluationArtifactId ? "completed" : "not recorded"} · promotion {lineage.promotable ? "eligible" : "blocked"}</span> : null}</div>
            </DetailSection>
            <DetailSection title="Promotion & bindings">
              <TrainingModelPromotion lineage={lineage} state={state} training={training} onToast={onToast} />
            </DetailSection>
          </> : null}
        </div>
      ) : tab === "details" ? (
        <div className="training-detail-sections">
          <DetailSection title="Training recipe">
            {plan?.recipe.method === "sft" ? <dl className="training-configuration-list">
              <Config label="Method" value={plan.recipe.method.toUpperCase()}/><Config label="Base model" value={plan.recipe.baseModel.id}/><Config label="Revision" value={plan.recipe.baseModel.revision}/><Config label="Compute" value={destinationLabel(plan.destinationId)}/><Config label="LoRA rank" value={String(plan.recipe.lora.rank)}/><Config label="Learning rate" value={String(plan.recipe.optimizer.learningRate)}/><Config label="Maximum steps" value={String(plan.recipe.optimizer.maxSteps)}/><Config label="Batch size" value={String(plan.recipe.optimizer.batchSize)}/><Config label="Gradient accumulation" value={String(plan.recipe.optimizer.gradientAccumulationSteps)}/><Config label="Sequence length" value={String(plan.recipe.dataset.maxSequenceLength)}/><Config label="Seed" value={String(plan.recipe.optimizer.seed)}/>
            </dl> : plan?.recipe.method === "grpo" ? <dl className="training-configuration-list">
              <Config label="Method" value="RFT"/><Config label="Loss method" value={plan.recipe.loss.method === "gspo-token" ? "GSPO-token" : plan.recipe.loss.method.toUpperCase()}/><Config label="Base model" value={plan.recipe.baseModel.id}/><Config label="Revision" value={plan.recipe.baseModel.revision}/><Config label="Compute" value={destinationLabel(plan.destinationId)}/><Config label="LoRA rank" value={String(plan.recipe.lora.rank)}/><Config label="Rollouts per prompt" value={String(plan.recipe.rollout.groupSize)}/><Config label="Rollout concurrency" value={String(plan.recipe.rollout.concurrency)}/><Config label="Maximum turns" value={String(plan.recipe.rollout.maxTurns)}/><Config label="Maximum output" value={String(plan.recipe.rollout.maxOutputTokens)}/><Config label="Learning rate" value={String(plan.recipe.optimizer.learningRate)}/><Config label="Optimizer steps" value={String(plan.recipe.optimizer.maxSteps)}/><Config label="Reward environment" value={`${plan.recipe.reward.environmentId}@${plan.recipe.reward.environmentVersion}`}/><Config label="Tool contract" value={plan.recipe.reward.toolContractHash}/>
            </dl> : <div className="training-run-placeholder">No run configuration yet.</div>}
          </DetailSection>
          <DetailSection title="Lineage">
            {lineage ? <dl className="training-configuration-list"><Config label="Taskset hash" value={lineage.tasksetHash}/><Config label="Grader hash" value={lineage.graderHash}/><Config label="Plan hash" value={lineage.planHash}/><Config label="Prepared data hash" value={lineage.bundleHash}/><Config label="Recipe hash" value={lineage.recipeHash}/><Config label="Worker" value={lineage.workerVersion}/><Config label="Trainer" value={lineage.trainerVersion}/></dl> : <div className="training-run-placeholder">Lineage is created with a verified adapter.</div>}
          </DetailSection>
          <DetailSection title="Artifacts">
            {artifacts.length ? <div className="training-artifact-list">{artifacts.map((artifact) => <div key={artifact.id}><span>{artifact.kind}</span><code>{String(artifact.metadata.relativePath ?? artifact.path)}</code><strong>{formatBytes(artifact.sizeBytes)}</strong></div>)}</div> : <div className="training-run-placeholder">No artifacts yet.</div>}
          </DetailSection>
          <DetailSection title="Event log">
            {detail.detail?.events.length ? <div className="training-event-log">{detail.detail.events.map((event) => <div key={event.id}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><strong>{statusLabel(event.type)}</strong><code>{eventSummary(event.payload)}</code></div>)}</div> : <div className="training-run-placeholder">No worker events yet.</div>}
          </DetailSection>
          {plan?.recipe.method === "grpo" ? <DetailSection title="Rollout receipts">
            <TrainingRolloutReceipts receipts={rolloutReceipts} />
          </DetailSection> : null}
        </div>
      ) : tab === "configuration" ? (
        <div className="training-detail-sections">
          <DetailSection title="Chat">
            <TrainingModelConfiguration lineage={modelLineage} training={training} onToast={onToast} />
          </DetailSection>
        </div>
      ) : (
        <div className="training-detail-sections">
          <DetailSection title="Settings">
            <div className="training-model-settings-actions">
              <button className="training-button danger" type="button" onClick={onDelete}>Delete model</button>
            </div>
          </DetailSection>
        </div>
      )}

      {startOpen ? <TrainingStartDialog
        baseModelCandidates={state?.baseModelCandidates ?? []}
        connection={connection}
        taskset={currentTaskset}
        baselineReports={state?.baselineReports.filter((report) =>
          report.tasksetId === currentTaskset.id
          && report.tasksetHash === currentTaskset.contentHash) ?? []}
        baselineRuns={state?.baselineRuns.filter((run) =>
          run.tasksetId === currentTaskset.id) ?? []}
        destinations={state?.destinations ?? []}
        busy={["baseline", "prepare-training", "start-prepared-training", "start-training"].includes(training.busyAction ?? "")}
        busyAction={training.busyAction}
        onClose={() => setStartOpen(false)}
        onOpenProviderSettings={onOpenProviderSettings}
        onRunBaseline={async (model, options) => Boolean(
          await training.actions.baseline(currentTaskset.id, model, options),
        )}
        onPrepare={(destinationId, recipe, approval) => training.actions.prepareTraining({
          tasksetId: taskset.id,
          destinationId,
          recipe,
          exportApproved: approval.exportApproved,
          retentionDays: approval.retentionDays,
          region: approval.region,
        })}
        onConfirmPrepared={async (prepared, maximumCostUsd) => Boolean(
          await training.actions.startPreparedTraining({
            planId: prepared.plan.id,
            bundleId: prepared.bundle.id,
            maximumCostUsd,
          }),
        )}
        onStart={async (destinationId: TrainingDestinationId, recipe, approval) => Boolean(await training.actions.startTraining({ tasksetId: taskset.id, destinationId, recipe, ...approval }))}
      /> : null}
    </div>
  );
}

function Config({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function shortId(value: string) { return value.replace(/^training_job_/, "").slice(0, 12); }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / (1024 ** 2)).toFixed(1)} MB`; }
function eventSummary(payload: Record<string, unknown>) {
  const compact = Object.fromEntries(Object.entries(payload).filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean").slice(0, 8));
  return JSON.stringify(compact);
}

function stageCompatibility(method: string, destinations: NonNullable<TrainingController["payload"]>["destinations"]): string {
  const compatible = destinations.filter((destination) => destination.available && destination.methods.includes(method as never));
  if (compatible.length) return `Available on ${compatible.map((destination) => destinationLabel(destination.destinationId)).join(", ")}`;
  return method === "sft" ? "No SFT destination is currently available" : "Execution backend unavailable; readiness contract only";
}
