import { useMemo, useState } from "react";
import type {
  ModelEvaluationReceipt,
  ModelRun,
  ProviderSettings,
  TrainingStateResponse,
} from "@openpond/contracts";

import { chatModelLabel, chatProviderLabel } from "../../lib/app-models";
import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";
import { formatDateTime } from "../training/training-model-data";
import { EvaluationComparisonCharts } from "./EvaluationComparisonCharts";
import {
  benchmarkForegroundUsage,
  benchmarkResultAccepted,
} from "./benchmark-attempt-usage";
import type { LabWorkproductSummary } from "./lab-workproducts";

type ComparableRun = {
  item: LabWorkproductSummary;
  receipt: ModelEvaluationReceipt;
  run: ModelRun;
};

export function LabModelComparisonDialog({
  items,
  providerSettings,
  state,
  onClose,
  onOpenModel,
}: {
  items: LabWorkproductSummary[];
  providerSettings: ProviderSettings | null;
  state: TrainingStateResponse;
  onClose: () => void;
  onOpenModel: (key: string) => void;
}) {
  const runs = useMemo(
    () => comparableRuns(items, state),
    [items, state],
  );
  const [leftId, setLeftId] = useState(runs[0]?.run.id ?? "");
  const [rightId, setRightId] = useState(runs[1]?.run.id ?? runs[0]?.run.id ?? "");
  const left = runs.find((entry) => entry.run.id === leftId) ?? runs[0] ?? null;
  const right = runs.find((entry) => entry.run.id === rightId) ?? runs[1] ?? runs[0] ?? null;
  const selected = left && right ? [left, right] : [];

  return (
    <AppDialog
      ariaLabel="Compare benchmark runs"
      backdropClassName="labs-rename-backdrop"
      className="labs-rename-dialog labs-model-compare-dialog"
      onClose={onClose}
    >
      <header>
        <div>
          <h2>Compare benchmark runs</h2>
          <p>Compare persisted results across models or across runs of one model.</p>
        </div>
        <button aria-label="Close comparison" type="button" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="labs-model-compare-body">
        {runs.length ? (
          <>
            <div className="labs-model-compare-selectors">
              <RunSelect
                label="First run"
                runs={runs}
                value={left?.run.id ?? ""}
                providerSettings={providerSettings}
                onChange={setLeftId}
              />
              <RunSelect
                label="Second run"
                runs={runs}
                value={right?.run.id ?? ""}
                providerSettings={providerSettings}
                onChange={setRightId}
              />
            </div>

            {selected.length === 2 ? (
              <>
                <EvaluationComparisonCharts
                  series={selected.map((entry) => {
                    const usage = benchmarkForegroundUsage(entry.receipt).candidate;
                    return {
                      id: entry.run.id,
                      label: comparisonLabel(entry, providerSettings),
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      tokens: usage.totalTokens,
                      passRate: entry.receipt.quality.candidatePassRate,
                      costUsd: usage.costUsd,
                    };
                  })}
                />
                <div className="labs-model-compare-facts">
                  {selected.map((entry) => (
                    <article key={entry.run.id}>
                      <header>
                        <div>
                          <strong>{entry.item.name}</strong>
                          <span>{runModelLabel(entry.run, providerSettings)}</span>
                        </div>
                        <button
                          className="training-button secondary labs-compact-button"
                          type="button"
                          onClick={() => onOpenModel(entry.item.key)}
                        >
                          View model
                        </button>
                      </header>
                      <dl>
                        <div>
                          <dt>Result</dt>
                          <dd>{titleCase(entry.receipt.terminalClassification)}</dd>
                        </div>
                        <div>
                          <dt>Quality</dt>
                          <dd>
                            {percent(entry.receipt.quality.baselinePassRate)} → {percent(entry.receipt.quality.candidatePassRate)}
                          </dd>
                        </div>
                        <div>
                          <dt>
                            {benchmarkResultAccepted(entry.receipt)
                              ? "Token change"
                              : "Diagnostic token change"}
                          </dt>
                          <dd>{signedPercent(entry.receipt.foregroundTokenDeltaPercent)}</dd>
                        </div>
                        <div>
                          <dt>Harness</dt>
                          <dd>
                            {entry.receipt.stages.baseline.contentHash
                              === entry.receipt.stages.candidate.contentHash
                              ? "Unchanged"
                              : "Updated"}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <p className="labs-model-benchmark-empty">
            Complete a benchmark to make its saved result available here.
          </p>
        )}
      </div>
    </AppDialog>
  );
}

function RunSelect({
  label,
  runs,
  value,
  providerSettings,
  onChange,
}: {
  label: string;
  runs: ComparableRun[];
  value: string;
  providerSettings: ProviderSettings | null;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {runs.map((entry) => (
          <option key={entry.run.id} value={entry.run.id}>
            {entry.item.name} · {runModelLabel(entry.run, providerSettings)} · {formatDateTime(entry.run.updatedAt)}
          </option>
        ))}
      </select>
    </label>
  );
}

function comparableRuns(
  items: LabWorkproductSummary[],
  state: TrainingStateResponse,
): ComparableRun[] {
  const itemsById = new Map(items.map((item) => [item.id, item] as const));
  return state.modelRuns.flatMap((run) => {
    const item = itemsById.get(run.modelId);
    const receipt = evaluationReceipt(run);
    return item && receipt ? [{ item, receipt, run }] : [];
  }).sort((left, right) => right.run.updatedAt.localeCompare(left.run.updatedAt));
}

function evaluationReceipt(run: ModelRun): ModelEvaluationReceipt | null {
  return run.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
    ? run.receipt
    : null;
}

function comparisonLabel(
  entry: ComparableRun,
  settings: ProviderSettings | null,
): string {
  return `${chatModelLabel(
    entry.run.evaluation?.model.modelId ?? "Unknown model",
    settings,
    entry.run.evaluation?.model.providerId,
  )} · ${compactTime(entry.run.updatedAt)}`;
}

function runModelLabel(run: ModelRun, settings: ProviderSettings | null): string {
  const model = run.evaluation?.model;
  if (!model) return "Unknown model";
  return `${chatProviderLabel(model.providerId, settings)} / ${chatModelLabel(
    model.modelId,
    settings,
    model.providerId,
  )}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number | null): string {
  if (value === null) return "Not comparable";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function compactTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
