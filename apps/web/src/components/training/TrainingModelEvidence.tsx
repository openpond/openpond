import { useState } from "react";
import type {
  ModelArtifactLineage,
  RolloutTrajectoryReceipt,
  Taskset,
  TrainingJob,
  TrainingStateResponse,
} from "@openpond/contracts";
import { destinationLabel } from "./training-model-data";

export function TrainingModelComparisons({
  method,
  taskset,
  state,
}: {
  method?: "sft" | "grpo";
  taskset: Taskset;
  state: TrainingStateResponse | null;
}) {
  const jobById = new Map(state?.jobs.map((job) => [job.id, job]) ?? []);
  const planById = new Map(state?.plans.map((plan) => [plan.id, plan]) ?? []);
  const lineages = state?.models
    .filter((model) => model.tasksetId === taskset.id)
    .filter((model) => {
      if (!method) return true;
      const job = jobById.get(model.jobId);
      const plan = job ? planById.get(job.planId) : null;
      return plan?.recipe.method === method;
    })
    .sort((left, right) => left.importedAt.localeCompare(right.importedAt)) ?? [];
  if (!lineages.length) {
    return <div className="training-run-placeholder">Comparisons appear after the first imported candidate.</div>;
  }
  const artifactById = new Map(state?.artifacts.map((artifact) => [artifact.id, artifact]) ?? []);
  const tasksetPlanIds = new Set(
    state?.plans.filter((plan) => plan.tasksetId === taskset.id).map((plan) => plan.id) ?? [],
  );
  const latestJob = state?.jobs
    .filter((job) => tasksetPlanIds.has(job.planId))
    .filter((job) => !method || planById.get(job.planId)?.recipe.method === method)
    .sort((left, right) =>
      (right.createdAt ?? right.updatedAt).localeCompare(left.createdAt ?? left.updatedAt),
    )[0] ?? null;
  const latestLineage = lineages.at(-1)!;
  const activeByLineage = new Map<string, string[]>();
  for (const binding of state?.modelBindings ?? []) {
    if (binding.status !== "active") continue;
    const roles = activeByLineage.get(binding.modelArtifactLineageId) ?? [];
    roles.push(`${binding.role}:${binding.roleTargetId}`);
    activeByLineage.set(binding.modelArtifactLineageId, roles);
  }

  return (
    <div className="training-table-wrap">
      <table className="training-data-table training-model-comparison-table">
        <thead>
          <tr><th>Candidate</th><th>Method</th><th>Compute</th><th>Base</th><th>Frozen Eval</th><th>Binding</th></tr>
        </thead>
        <tbody>
          <BaseRow lineage={latestLineage} referenceJob={latestJob} state={state} />
          {lineages.map((lineage, index) => {
            const job = jobById.get(lineage.jobId);
            const plan = job ? planById.get(job.planId) : null;
            const evaluation = lineage.frozenEvaluationArtifactId
              ? artifactById.get(lineage.frozenEvaluationArtifactId)
              : null;
            const trainedPassRate = number(evaluation?.metadata.trainedPassRate);
            const basePassRate = number(evaluation?.metadata.basePassRate);
            const evaluationComplete = evaluation?.metadata.evaluationComplete;
            return (
              <tr key={lineage.id}>
                <td><strong>{index === lineages.length - 1 ? "Latest candidate" : `Prior candidate ${index + 1}`}</strong><small>{shortId(lineage.id)}</small></td>
                <td>{plan?.recipe.method === "grpo" ? "RFT" : plan?.recipe.method.toUpperCase() ?? "Unknown"}</td>
                <td>{plan ? destinationLabel(plan.destinationId) : "Unknown"}</td>
                <td>{plan?.recipe.method === "sft" || plan?.recipe.method === "grpo" ? plan.recipe.baseModel.id : "Unknown"}</td>
                <td>{evaluationComplete === false
                  ? "Infrastructure blocked"
                  : trainedPassRate == null
                    ? lineage.promotable ? "Passed" : "Unavailable"
                    : `${percent(trainedPassRate)} (${signedPercent((trainedPassRate ?? 0) - (basePassRate ?? 0))})`}</td>
                <td>{activeByLineage.get(lineage.id)?.join(", ") ?? (lineage.status === "rejected" ? "Rejected" : "Not active")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TrainingRolloutReceipts({
  receipts,
}: {
  receipts: RolloutTrajectoryReceipt[];
}) {
  const [showAll, setShowAll] = useState(false);
  if (!receipts.length) {
    return <div className="training-run-placeholder">No on-policy rollout receipts were recorded for this run.</div>;
  }
  const ordered = [...receipts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visible = showAll ? ordered : ordered.slice(0, 24);
  return (
    <div className="training-rollout-receipts">
      {receipts.length > 24 ? (
        <div className="training-rollout-receipt-controls">
          <span>{showAll
            ? `Showing all ${receipts.length} receipts`
            : `Showing latest ${visible.length} of ${receipts.length} receipts`}</span>
          <button
            className="training-text-button"
            type="button"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? "Show latest 24" : `Show all ${receipts.length}`}
          </button>
        </div>
      ) : null}
      {visible.map((receipt) => (
        <details key={receipt.id}>
          <summary>
            <span>{shortId(receipt.providerTrace.rolloutId)}</span>
            <strong>{receipt.status}</strong>
            <em>{receipt.reward.eligible && receipt.reward.raw != null ? receipt.reward.raw.toFixed(3) : receipt.failureClass ?? "not reward eligible"}</em>
          </summary>
          <dl className="training-configuration-list">
            <Config label="Correlation" value={receipt.correlationId} />
            <Config label="Task" value={receipt.taskId} />
            <Config label="Policy" value={receipt.policy.modelId} />
            <Config label="Checkpoint" value={receipt.policy.checkpointId ?? "Provider initial policy"} />
            <Config label="Environment" value={`${receipt.environment.id}@${receipt.environment.version}`} />
            <Config label="World" value={`${receipt.environment.worldId} · ${receipt.environment.worldHash}`} />
            <Config label="Raw reward" value={receipt.reward.raw == null ? "Not eligible" : String(receipt.reward.raw)} />
            <Config label="Components" value={JSON.stringify(receipt.reward.components)} />
            <Config label="Outcome" value={receipt.verifier?.outcome ?? receipt.failureClass ?? "Pending"} />
            <Config label="Trace" value={`${receipt.providerTrace.experimentId}/${receipt.providerTrace.rolloutId}`} />
          </dl>
        </details>
      ))}
    </div>
  );
}

function BaseRow({
  lineage,
  referenceJob,
  state,
}: {
  lineage: ModelArtifactLineage;
  referenceJob: TrainingJob | null;
  state: TrainingStateResponse | null;
}) {
  const job = referenceJob ?? state?.jobs.find((item) => item.id === lineage.jobId);
  const plan = job ? state?.plans.find((item) => item.id === job.planId) : null;
  const evaluation = job?.id === lineage.jobId && lineage.frozenEvaluationArtifactId
    ? state?.artifacts.find((item) => item.id === lineage.frozenEvaluationArtifactId)
    : null;
  const basePassRate = number(evaluation?.metadata.basePassRate);
  const evaluationComplete = evaluation?.metadata.evaluationComplete;
  const evaluationPending = Boolean(
    job && ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status),
  );
  return (
    <tr className="training-comparison-base">
      <td><strong>Base model</strong><small>Shared frozen-Eval reference</small></td>
      <td>BASE</td>
      <td>{plan ? destinationLabel(plan.destinationId) : "Unknown"}</td>
      <td>{plan?.recipe.method === "sft" || plan?.recipe.method === "grpo" ? plan.recipe.baseModel.id : "Unknown"}</td>
      <td>{evaluationComplete === false
        ? "Infrastructure blocked"
        : evaluationPending
          ? "Pending for active run"
        : basePassRate == null
          ? "Not recorded"
          : percent(basePassRate)}</td>
      <td>Reference only</td>
    </tr>
  );
}

function Config({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number) {
  const points = Math.round(value * 100);
  return `${points >= 0 ? "+" : ""}${points} pts`;
}

function shortId(value: string) {
  return value.replace(/^lineage_/, "").slice(0, 18);
}
