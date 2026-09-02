import type { ModelComparisonSeries, ModelComparisonSeriesEntry, ModelRun } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, it, vi } from "vitest";

import { createModelComparisonEvaluationScheduler } from "./model-comparison-evaluation-scheduler.js";
import { currencyPanelsForEntry } from "./model-currency-projection-service.js";

const hash = (value: unknown) => contentHash(value);

describe("automatic Model Comparison evaluation scheduling", () => {
  it("serializes concurrent reconciliation and invokes the manual evaluation service once", async () => {
    const series = fixtureSeries(true);
    const entry = fixtureEntry();
    const runs: ModelRun[] = [];
    const start = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    const store = fixtureStore(series, entry, runs);
    const scheduler = createModelComparisonEvaluationScheduler({ store: store as never, evaluations: { start } as never });

    const [left, right] = await Promise.all([scheduler.reconcileAutomatic(), scheduler.reconcileAutomatic()]);

    expect(left?.id).toBe(right?.id);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      entryId: entry.id,
      targetBaseCheckpointId: "base-checkpoint-output",
      maximumSpendUsd: 10,
      maxGpuSeconds: 7_200,
      idempotencyKey: expect.stringContaining(`automatic:${series.benchmarkProtocol!.contentHash}`),
    }));
  });

  it("does not schedule disabled series and targets the exact candidate after parent evidence exists", async () => {
    const disabled = fixtureSeries(false);
    const entry = fixtureEntry();
    const disabledStart = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    await createModelComparisonEvaluationScheduler({ store: fixtureStore(disabled, entry, []) as never, evaluations: { start: disabledStart } as never }).reconcileAutomatic();
    expect(disabledStart).not.toHaveBeenCalled();

    const enabled = fixtureSeries(true);
    const panelId = "development";
    const parentRun = existingRun(enabled, entry, panelId, "base_model", null);
    const candidateStart = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    await createModelComparisonEvaluationScheduler({ store: fixtureStore(enabled, entry, [parentRun]) as never, evaluations: { start: candidateStart } as never }).reconcileAutomatic();
    expect(candidateStart).toHaveBeenCalledWith(expect.objectContaining({ panelId, targetModelVersionId: entry.modelVersionId }));
  });

  it("does not schedule comparisons until every sealed sweep pass has a published Model Version", async () => {
    const series = fixtureSeries(true);
    const entry = fixtureEntry();
    const start = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    const store = fixtureStore(series, entry, []);
    store.listModelComparisonSeriesEntries = async () => [entry];

    await createModelComparisonEvaluationScheduler({
      store: store as never,
      evaluations: { start } as never,
    }).reconcileAutomatic();

    expect(start).not.toHaveBeenCalled();
  });

  it("starts sealed frontier references only after the complete candidate matrix", async () => {
    const series = fixtureSeries(true);
    const seedEntry = fixtureEntry();
    const entries = fixtureEntries(series, seedEntry);
    const runs = entries.flatMap((entry) => currencyPanelsForEntry(series, entry).flatMap((panel) => [
      existingRun(series, entry, panel.id, "base_model", null),
      existingRun(series, entry, panel.id, "model_version", entry.modelVersionId),
    ]));
    const start = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    const startReference = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));

    await createModelComparisonEvaluationScheduler({
      store: fixtureStore(series, seedEntry, runs) as never,
      evaluations: { start, startReference } as never,
    }).reconcileAutomatic();

    expect(start).not.toHaveBeenCalled();
    expect(startReference).toHaveBeenCalledWith(expect.objectContaining({
      seriesId: series.id,
      entryId: "scheduler-entry-schedule-p1",
      targetKind: "external_reference",
      label: "frontier-reference",
      model: { providerId: "codex", modelId: "frontier-model" },
      idempotencyKey: expect.stringContaining("automatic-reference:"),
    }));
  });

  it("retries terminal failures with distinct identities and stops after the bounded attempt count", async () => {
    const series = fixtureSeries(true);
    const entry = fixtureEntry();
    const failed = failedRun(existingRun(series, entry, "development", "base_model", null), "failed-base-1");
    const retryStart = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    await createModelComparisonEvaluationScheduler({
      store: fixtureStore(series, entry, [failed]) as never,
      evaluations: { start: retryStart } as never,
    }).reconcileAutomatic();
    expect(retryStart).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/:attempt:2$/),
    }));

    const exhaustedStart = vi.fn(async (input: Record<string, unknown>) => preparedRun(input));
    await createModelComparisonEvaluationScheduler({
      store: fixtureStore(series, entry, [
        failed,
        failedRun(failed, "failed-base-2"),
        failedRun(failed, "failed-base-3"),
      ]) as never,
      evaluations: { start: exhaustedStart } as never,
    }).reconcileAutomatic();
    expect(exhaustedStart).not.toHaveBeenCalled();
  });
});

function fixtureSeries(enabled: boolean): ModelComparisonSeries {
  const taskset = (id: string) => ({ id: `taskset-${id}`, revision: 1, contentHash: hash(id) });
  const panels = [
    { id: "p0-correction", role: "correction", passLabel: "P0", taskset: taskset("p0-correction") },
    { id: "p0-sibling", role: "sibling_verification", passLabel: "P0", taskset: taskset("p0-sibling") },
    { id: "p0-known", role: "cumulative_known", passLabel: "P0", taskset: taskset("p0-known") },
    { id: "development", role: "development", passLabel: null, taskset: taskset("development") },
    { id: "retained", role: "retained", passLabel: null, taskset: taskset("retained") },
    { id: "frozen", role: "frozen_final", passLabel: null, taskset: taskset("frozen") },
    { id: "eligible", role: "training_eligible", passLabel: null, taskset: taskset("eligible") },
  ].map((panel) => ({ ...panel, familyIds: [`family-${panel.id}`], taskCount: 1, sealedAt: "2026-09-02T12:00:00.000Z" }));
  return {
    id: "scheduler-series",
    automaticEvaluation: { enabled },
    scheduleSealedAt: "2026-09-02T12:00:00.000Z",
    schedule: [
      { id: "schedule-p0", ordinal: 0, label: "P0" },
      { id: "schedule-p1", ordinal: 1, label: "P1" },
    ],
    benchmarkProtocol: {
      id: "scheduler-protocol",
      contentHash: hash("scheduler-protocol"),
      panels,
      schedule: [
        { scheduleEntryId: "schedule-p0", ordinal: 0, label: "P0", correctionPanelIds: ["p0-correction"] },
        { scheduleEntryId: "schedule-p1", ordinal: 1, label: "P1", correctionPanelIds: ["p0-correction"] },
      ],
      evaluation: { seeds: [1, 2, 3], repetitions: 3 },
      policies: {
        externalReferences: [{
          kind: "external_reference",
          id: "frontier-reference",
          model: { providerId: "codex", modelId: "frontier-model" },
          providerRevision: "frontier-revision",
          contentHash: hash("frontier-reference"),
        }],
      },
      resources: { maximumProviderSpendUsd: 1_000, maximumTotalSpendUsd: 5_000, maximumEvaluationGpuSeconds: 500_000 },
    },
    baseModel: { id: "scheduler-base", revision: "base-revision" },
  } as unknown as ModelComparisonSeries;
}

function fixtureEntry(): ModelComparisonSeriesEntry {
  return {
    id: "scheduler-entry", seriesId: "scheduler-series", scheduleEntryId: "schedule-p0", ordinal: 0, status: "candidate", modelVersionId: "scheduler-candidate",
    parent: { kind: "base_model", id: "scheduler-base", revision: "base-revision" },
  } as ModelComparisonSeriesEntry;
}

function fixtureStore(series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry, runs: ModelRun[]) {
  const entries = fixtureEntries(series, entry);
  return {
    listModelComparisonSeries: async () => [series],
    listModelComparisonSeriesEntries: async () => entries,
    listModelRuns: async () => runs,
    listTrainingArtifacts: async () => [{ kind: "checkpoint", baseModelId: series.baseModel.id, baseModelRevision: series.baseModel.revision, metadata: { policyVersion: 3, managedRlOutputId: "base-checkpoint-output" } }],
  };
}

function fixtureEntries(series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry): ModelComparisonSeriesEntry[] {
  return series.schedule.map((scheduled) => scheduled.id === entry.scheduleEntryId
    ? entry
    : ({
        ...entry,
        id: `scheduler-entry-${scheduled.id}`,
        scheduleEntryId: scheduled.id,
        ordinal: scheduled.ordinal,
        label: scheduled.label,
        modelVersionId: `scheduler-candidate-${scheduled.id}`,
      }) as ModelComparisonSeriesEntry);
}

function preparedRun(input: Record<string, unknown>): ModelRun {
  return { id: `prepared-${String(input.panelId)}`, status: "prepared" } as ModelRun;
}

function existingRun(series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry, panelId: string, kind: "base_model" | "model_version", modelVersionId: string | null): ModelRun {
  return {
    id: `existing-${panelId}-${kind}`,
    kind: "evaluation",
    status: "succeeded",
    evaluation: {
      benchmarkId: "model-comparison",
      series: { id: series.id, protocol: { id: series.benchmarkProtocol!.id, revision: series.benchmarkProtocol!.revision, contentHash: series.benchmarkProtocol!.contentHash } },
      comparisonPair: { entryId: entry.id, parent: entry.parent, candidateModelVersionId: entry.modelVersionId! },
      panel: { id: panelId, role: "development", passLabel: null },
      target: { kind, label: kind === "base_model" ? series.baseModel.id : entry.label, modelVersionId, model: null },
    },
  } as ModelRun;
}

function failedRun(run: ModelRun, id: string): ModelRun {
  return { ...run, id, status: "failed", failure: "transient hosted failure" };
}
