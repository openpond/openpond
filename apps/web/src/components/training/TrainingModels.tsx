import { useState, type ReactNode } from "react";
import type { Taskset, TrainingBundleManifest, TrainingDestinationId, TrainingPlan } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { Download, X } from "../icons";

type TrainingController = ReturnType<typeof useTraining>;
type PreparedHandoff = { tasksetId: string; plan: TrainingPlan; manifest: TrainingBundleManifest; directory: string };

export function TrainingModels({
  training,
  preparedHandoff,
  onClearPrepared,
  onDownloadBundle,
  onLaunchBundle,
  onOpenTaskset,
  onPrepareTraining,
}: {
  training: TrainingController;
  preparedHandoff: PreparedHandoff | null;
  onClearPrepared: () => void;
  onDownloadBundle: (bundleId: string) => void;
  onLaunchBundle: (plan: TrainingPlan, manifest: TrainingBundleManifest) => Promise<void>;
  onOpenTaskset: (tasksetId: string) => void;
  onPrepareTraining: (taskset: Taskset, destinationId?: TrainingDestinationId) => Promise<void>;
}) {
  const state = training.payload;
  const tasksets = state?.tasksets ?? [];
  const activeCreations = (state?.creations ?? []).filter((creation) =>
    !creation.materializedTasksetId && !["cancelled", "failed"].includes(creation.state));
  const bundles = state?.bundles ?? [];
  const [artifactDirectory, setArtifactDirectory] = useState("");
  const [bundleId, setBundleId] = useState("");
  const selectedBundle = bundles.find((bundle) => bundle.id === bundleId) ?? bundles[0] ?? null;
  const hasBuilds = activeCreations.length > 0 || tasksets.length > 0;

  return (
    <div className="training-page-body">
      {hasBuilds ? (
        <div className="training-model-builds">
          {activeCreations.map((creation) => (
            <article className="training-model-build" key={creation.id}>
              <div className="training-model-build-heading">
                <div><strong>{creation.proposal?.name ?? creation.request.objective ?? "New model"}</strong><span>Creating Taskset</span></div>
              </div>
              <div className="training-model-steps">
                <ModelStep number={1} label="Taskset" value={creation.state.replaceAll("_", " ")} active />
                <ModelStep number={2} label="Training setup" value="Not started" />
                <ModelStep number={3} label="Training" value="Not started" />
                <ModelStep number={4} label="Evaluation" value="Not started" />
                <ModelStep number={5} label="Result" value="Not created" />
              </div>
              <div className="training-model-next"><span>Next</span><button className="training-button" type="button" onClick={() => onOpenTaskset(creation.materializedTasksetId ?? "")}>Continue Taskset</button></div>
            </article>
          ))}
          {tasksets.map((taskset) => (
            <ModelBuildRow
              key={taskset.id}
              taskset={taskset}
              training={training}
              preparedHandoff={preparedHandoff?.tasksetId === taskset.id ? preparedHandoff : null}
              onClearPrepared={onClearPrepared}
              onDownloadBundle={onDownloadBundle}
              onLaunchBundle={onLaunchBundle}
              onOpenTaskset={() => onOpenTaskset(taskset.id)}
              onPrepareTraining={onPrepareTraining}
            />
          ))}
        </div>
      ) : <p className="training-empty">No models yet.</p>}

      {bundles.length ? <details className="training-model-import">
        <summary>Import external result</summary>
        <p className="training-muted">Attach an adapter produced outside OpenPond to the bundle it was trained from. OpenPond verifies the files and runs the saved evaluation.</p>
        <div className="training-import-fields">
          <select aria-label="Training bundle" value={selectedBundle?.id ?? ""} onChange={(event) => setBundleId(event.target.value)}>
            <option value="" disabled>Select bundle</option>
            {bundles.map((bundle) => {
              const taskset = state?.tasksets.find((item) => item.id === bundle.tasksetId);
              return <option value={bundle.id} key={bundle.id}>{taskset?.name ?? bundle.tasksetId}</option>;
            })}
          </select>
          <input aria-label="Artifact folder" value={artifactDirectory} onChange={(event) => setArtifactDirectory(event.target.value)} placeholder="/path/to/artifact"/>
          <button className="training-button" disabled={!selectedBundle || !artifactDirectory.trim() || Boolean(training.busyAction)} onClick={() => selectedBundle && void training.actions.importArtifact(selectedBundle.planId, selectedBundle.id, artifactDirectory.trim())}>Import and evaluate</button>
        </div>
      </details> : null}
    </div>
  );
}

function ModelBuildRow({
  taskset,
  training,
  preparedHandoff,
  onClearPrepared,
  onDownloadBundle,
  onLaunchBundle,
  onOpenTaskset,
  onPrepareTraining,
}: {
  taskset: Taskset;
  training: TrainingController;
  preparedHandoff: PreparedHandoff | null;
  onClearPrepared: () => void;
  onDownloadBundle: (bundleId: string) => void;
  onLaunchBundle: (plan: TrainingPlan, manifest: TrainingBundleManifest) => Promise<void>;
  onOpenTaskset: () => void;
  onPrepareTraining: (taskset: Taskset, destinationId?: TrainingDestinationId) => Promise<void>;
}) {
  const state = training.payload;
  const plan = state?.plans.find((item) => item.tasksetId === taskset.id) ?? preparedHandoff?.plan ?? null;
  const bundle = plan ? state?.bundles.find((item) => item.planId === plan.id) ?? (preparedHandoff?.plan.id === plan.id ? preparedHandoff.manifest : null) : null;
  const job = plan ? state?.jobs.find((item) => item.planId === plan.id) ?? null : null;
  const model = job ? state?.models.find((item) => item.jobId === job.id) ?? null : null;
  const artifact = model ? state?.artifacts.find((item) => item.id === model.artifactId) ?? null : null;
  const availableDestinations = (state?.destinations ?? []).filter((destination) => destination.available && destination.methods.includes("sft"));
  const initialDestination = availableDestinations.some((destination) => destination.destinationId === "local_cpu_fixture")
    ? "local_cpu_fixture"
    : availableDestinations[0]?.destinationId ?? "export";
  const [destinationId, setDestinationId] = useState<TrainingDestinationId>(initialDestination);
  const jobActive = Boolean(job && ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status));
  const title = artifact?.baseModelId ? `${artifact.baseModelId} adapter` : plan?.recipe.method === "sft" ? plan.recipe.baseModel.id : "New model";

  return (
    <article className="training-model-build">
      <div className="training-model-build-heading"><div><strong>{title}</strong></div></div>
      <div className="training-model-steps">
        <ModelStep number={1} label="Taskset" value={taskset.name} complete />
        <ModelStep number={2} label="Training setup" value={plan ? setupSummary(plan) : "Not configured"} complete={Boolean(plan)} active={!plan && Boolean(taskset.readiness?.ready)} />
        <ModelStep number={3} label="Training" value={job ? statusLabel(job.status) : "Not started"} complete={job?.status === "succeeded"} active={Boolean(plan && !job)} />
        <ModelStep number={4} label="Evaluation" value={model?.frozenEvaluationArtifactId ? "Completed" : "Not started"} complete={Boolean(model?.frozenEvaluationArtifactId)} active={job?.status === "succeeded" && !model} />
        <ModelStep number={5} label="Result" value={model ? "Adapter ready" : "Not created"} complete={Boolean(model)} />
      </div>
      <div className="training-model-next">
        <span>Next</span>
        {!taskset.readiness?.ready ? (
          <><p>{tasksetBlocker(taskset)}</p><button className="training-button secondary" type="button" onClick={onOpenTaskset}>Open Taskset</button></>
        ) : !plan ? (
          <><div className="training-model-setup-summary"><span>Method <strong>SFT</strong></span><span>Base model <strong>Local CPU fixture</strong></span></div><label className="training-model-compute"><span>Compute</span><select aria-label={`Compute for ${taskset.name}`} value={destinationId} onChange={(event) => setDestinationId(event.target.value as TrainingDestinationId)}>{availableDestinations.length ? availableDestinations.map((destination) => <option value={destination.destinationId} key={destination.destinationId}>{destinationLabel(destination.destinationId)}</option>) : <option value="export">Export only</option>}</select></label><button className="training-button" type="button" disabled={Boolean(training.busyAction)} onClick={() => void onPrepareTraining(taskset, destinationId)}>Prepare</button></>
        ) : !bundle ? (
          <button className="training-button" type="button" disabled={Boolean(training.busyAction)} onClick={() => void training.actions.buildBundle(plan.id)}>Build bundle</button>
        ) : !job || ["failed", "cancelled"].includes(job.status) ? (
          plan.destinationId === "export" ? <button className="training-button" type="button" onClick={() => onDownloadBundle(bundle.id)}>Download bundle</button> : <><button className="training-button" type="button" disabled={Boolean(training.busyAction)} onClick={() => void onLaunchBundle(plan, bundle)}>Start training</button>{preparedHandoff ? <button className="training-text-button" type="button" onClick={onClearPrepared}>Cancel</button> : null}</>
        ) : jobActive ? (
          <button className="training-text-button danger" type="button" disabled={job.status === "cancelling"} onClick={() => void training.actions.cancelJob(job.id)}><X size={13}/>Cancel training</button>
        ) : model && artifact ? (
          <button className="training-button secondary" type="button" onClick={() => void training.actions.downloadArtifact(artifact.id)}><Download size={14}/>Download adapter</button>
        ) : <span className="training-muted">Collecting the model result…</span>}
      </div>
    </article>
  );
}

function ModelStep({ number, label, value, active = false, complete = false }: { number: number; label: string; value: ReactNode; active?: boolean; complete?: boolean }) {
  return <div className={`training-model-step ${active ? "active" : ""} ${complete ? "complete" : ""}`}><span>{number}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function setupSummary(plan: TrainingPlan) {
  if (plan.recipe.method !== "sft") return plan.recipe.method.toUpperCase();
  return <><span>{plan.recipe.method.toUpperCase()}</span><span>{plan.recipe.baseModel.id}</span><span>{destinationLabel(plan.destinationId)}</span></>;
}

function tasksetBlocker(taskset: Taskset) {
  const codes = new Set(taskset.readiness?.blockers.map((blocker) => blocker.code) ?? []);
  if (codes.has("sft_demonstrations_missing")) return "Add a training chat before configuring this model.";
  if (codes.has("frozen_eval_missing")) return "Add an evaluation chat before configuring this model.";
  return "Review the Taskset before configuring this model.";
}

function destinationLabel(destination: string) {
  const labels: Record<string, string> = {
    export: "Export only",
    local_cpu_fixture: "Local CPU",
    local_cuda: "Local GPU",
    ssh_gpu: "SSH GPU",
    runpod_byoc: "RunPod",
    prime_hosted: "Prime hosted",
    fireworks: "Fireworks",
    openpond_managed: "OpenPond managed",
  };
  return labels[destination] ?? destination.replaceAll("_", " ");
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}
