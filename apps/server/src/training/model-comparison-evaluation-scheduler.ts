import type { ModelComparisonParent, ModelComparisonSeries, ModelComparisonSeriesEntry, ModelRun } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import type { createModelComparisonEvaluationService } from "./model-comparison-evaluation-service.js";
import { currencyPanelsForEntry } from "./model-currency-projection-service.js";

type Evaluations = ReturnType<typeof createModelComparisonEvaluationService>;

// The hosted serving-soak contract deliberately bounds one allocation to two
// GPU hours. Protocol resource ceilings describe the whole benchmark and may
// be much larger, so automatic runs must translate them into a safe per-soak
// allowance instead of forwarding the series-wide ceiling verbatim.
const HOSTED_SERVING_MAX_GPU_SECONDS = 7_200;
const AUTOMATIC_EVALUATION_MAX_SPEND_USD = 10;
const AUTOMATIC_EVALUATION_MAX_ATTEMPTS = 3;

export function createModelComparisonEvaluationScheduler(deps: { store: SqliteStore; evaluations: Evaluations }) {
  let active: Promise<ModelRun | null> | null = null;

  function reconcileAutomatic(): Promise<ModelRun | null> {
    if (active) return active;
    active = reconcileOnce().finally(() => { active = null; });
    return active;
  }

  async function reconcileOnce(): Promise<ModelRun | null> {
    const [seriesRecords, entries, runs] = await Promise.all([
      deps.store.listModelComparisonSeries(),
      deps.store.listModelComparisonSeriesEntries(),
      deps.store.listModelRuns(),
    ]);
    const enabled = new Map(seriesRecords.filter((series) => series.automaticEvaluation.enabled && series.scheduleSealedAt && series.benchmarkProtocol).map((series) => [series.id, series]));
    // A production sweep is trained as one sealed experiment. Publishing an
    // intermediate candidate must not start paid comparison work while later
    // branches are still missing. Once every scheduled pass has an exact Model
    // Version, reconciliation walks the full matrix from the first pass.
    for (const [seriesId, series] of enabled) {
      const publishedScheduleEntries = new Set(
        entries
          .filter((entry) => entry.seriesId === seriesId && entry.modelVersionId)
          .map((entry) => entry.scheduleEntryId),
      );
      if (series.schedule.some((scheduled) => !publishedScheduleEntries.has(scheduled.id))) {
        enabled.delete(seriesId);
      }
    }
    if (runs.some((run) => run.kind === "evaluation" && run.evaluation?.benchmarkId === "model-comparison" && run.evaluation.series && enabled.has(run.evaluation.series.id) && (run.status === "prepared" || run.status === "running"))) return null;

    const publishable = entries
      .filter((entry) => entry.modelVersionId && enabled.has(entry.seriesId) && ["candidate", "accepted", "rejected", "no_signal"].includes(entry.status))
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    for (const entry of publishable) {
      const series = enabled.get(entry.seriesId)!;
      const panels = currencyPanelsForEntry(series, entry);
      for (const panel of panels) {
        for (const target of [entry.parent, { kind: "model_version" as const, id: entry.modelVersionId!, contentHash: "" }]) {
          const priorAttempts = matchingEvaluations(runs, series, entry, panel.id, target);
          if (priorAttempts.some((run) => run.status === "succeeded")) continue;
          // Reconciliation is intentionally serialized above, and active runs
          // short-circuit the whole scheduler. Reaching the bounded terminal
          // count here means human review is required rather than silently
          // advancing to the paired candidate or spinning paid retries.
          if (priorAttempts.length >= AUTOMATIC_EVALUATION_MAX_ATTEMPTS) return null;
          const attempt = priorAttempts.length + 1;
          const common = {
            entryId: entry.id,
            cohortRole: panel.role,
            panelId: panel.id,
            taskset: panel.taskset,
            seeds: series.benchmarkProtocol!.evaluation.seeds,
            repetitions: series.benchmarkProtocol!.evaluation.repetitions,
            maximumSpendUsd: Math.min(
              AUTOMATIC_EVALUATION_MAX_SPEND_USD,
              series.benchmarkProtocol!.resources.maximumProviderSpendUsd,
              series.benchmarkProtocol!.resources.maximumTotalSpendUsd,
            ),
            maxGpuSeconds: Math.min(
              HOSTED_SERVING_MAX_GPU_SECONDS,
              series.benchmarkProtocol!.resources.maximumEvaluationGpuSeconds,
            ),
            idempotencyKey: `automatic:${series.benchmarkProtocol!.contentHash}:${entry.id}:${panel.id}:${policyKey(target)}:attempt:${attempt}`,
          };
          if (target.kind === "model_version") return deps.evaluations.start({ ...common, targetModelVersionId: target.id });
          const checkpointId = await resolveBaseCheckpoint(deps.store, series);
          if (checkpointId) return deps.evaluations.start({ ...common, targetBaseCheckpointId: checkpointId });
        }
      }
    }
    return null;
  }

  return { reconcileAutomatic };
}

function matchingEvaluations(runs: ModelRun[], series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry, panelId: string, target: ModelComparisonParent | { kind: "model_version"; id: string; contentHash: string }): ModelRun[] {
  const expected = policyKey(target);
  return runs.filter((run) => {
    const evaluation = run.evaluation;
    if (evaluation?.benchmarkId !== "model-comparison") return false;
    const actual = evaluation.target.kind === "model_version"
      ? `model_version:${evaluation.target.modelVersionId ?? "missing"}`
      : `${evaluation.target.kind}:${evaluation.target.label}`;
    return evaluation.series?.id === series.id
      && evaluation.series.protocol.contentHash === series.benchmarkProtocol?.contentHash
      && evaluation.comparisonPair?.entryId === entry.id
      && evaluation.panel?.id === panelId
      && actual === expected;
  });
}

export async function resolveBaseCheckpoint(store: SqliteStore, series: ModelComparisonSeries): Promise<string | null> {
  const artifacts = await store.listTrainingArtifacts();
  for (const artifact of artifacts) {
    if (artifact.kind !== "checkpoint" || artifact.baseModelId !== series.baseModel.id || artifact.baseModelRevision !== series.baseModel.revision) continue;
    const outputId = artifact.metadata.managedRlOutputId;
    // The hosted serving-soak API uses a ready checkpoint only as an immutable
    // source-job anchor when target=base_model; it deliberately ignores the
    // checkpoint adapter and serves policy version 0. Requiring a synthetic
    // policy-0 checkpoint here made exact base evaluation impossible because
    // training only publishes checkpoints after optimizer updates.
    if (typeof outputId === "string" && outputId.trim()) return outputId;
  }
  return null;
}

function policyKey(target: ModelComparisonParent | { kind: "model_version"; id: string; contentHash: string }): string {
  return target.kind === "model_version" ? `model_version:${target.id}` : `base_model:${target.id}`;
}
