import { useMemo, useState } from "react";
import {
  type ChatModelRef,
  type ChatProvider,
  type CodexReasoningEffort,
  type ModelEvaluationReceipt,
  type ModelEvaluationStopReceipt,
  type ProviderSettings,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";
import { formatDateTime, statusLabel } from "../training/training-model-data";
import {
  chatModelLabel,
  modelOptionsForProvider,
  providerOptionsFromSettings,
} from "../../lib/app-models";
import { EvaluationComparisonCharts } from "./EvaluationComparisonCharts";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  benchmarkForegroundUsage,
  benchmarkTaskEfficiency,
} from "./benchmark-attempt-usage";
import type { LabWorkproductSummary } from "./lab-workproducts";

type TrainingController = ReturnType<typeof useTraining>;

export function LabModelBenchmarksSection({
  workproduct,
  training,
  readOnly,
  defaultModel,
  initialModel,
  providerSettings,
  onClose,
  onOpenEntry,
  onToast,
}: {
  workproduct: LabWorkproductSummary;
  training: TrainingController;
  readOnly: boolean;
  defaultModel: ChatModelRef;
  initialModel: ChatModelRef | null;
  providerSettings: ProviderSettings | null;
  onClose: () => void;
  onOpenEntry: (entryKey: string) => void;
  onToast: ShowAppToast;
}) {
  const [effort, setEffort] = useState<CodexReasoningEffort>("high");
  const [configuredModel, setConfiguredModel] = useState<ChatModelRef>(
    initialModel ?? defaultModel,
  );
  const [starting, setStarting] = useState(false);
  const runs = useMemo(
    () =>
      (training.payload?.modelRuns ?? [])
        .filter(
          (run) =>
            run.modelId === workproduct.id
            && run.kind === "evaluation"
            && run.evaluation?.benchmarkId === "harness-refiner",
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [training.payload?.modelRuns, workproduct.id],
  );
  const latest = runs[0] ?? null;
  const receipt = evaluationReceipt(latest?.receipt ?? null);
  const foregroundUsage = receipt ? benchmarkForegroundUsage(receipt) : null;
  const taskEfficiency = receipt ? benchmarkTaskEfficiency(receipt) : null;
  const stopReceipt = evaluationStopReceipt(latest?.receipt ?? null);
  const taskset = (training.payload?.tasksets ?? []).find(
    (candidate) => candidate.benchmark?.definitionId === "harness-refiner",
  );
  const modelGroups = useMemo(
    () => benchmarkModelGroups(providerSettings, configuredModel),
    [configuredModel, providerSettings],
  );

  async function startBenchmark() {
    setStarting(true);
    try {
      const run = await training.actions.startHarnessRefinerBenchmark(
        workproduct.id,
        configuredModel,
        effort,
      );
      if (!run) throw new Error("Benchmark start returned no Model Run.");
      onOpenEntry(`model-run:${run.id}`);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <AppDialog
      ariaLabel={`Benchmark ${workproduct.name}`}
      backdropClassName="labs-rename-backdrop"
      className="labs-rename-dialog labs-model-benchmark-dialog"
      dismissDisabled={starting}
      onClose={onClose}
    >
      <header>
        <div>
          <h2>Benchmark model</h2>
          <p>Run a controlled evaluation and save it in this Model's history.</p>
        </div>
        <button
          aria-label="Close benchmark setup"
          disabled={starting}
          type="button"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      <div className="labs-model-benchmark-dialog-body">
        <article className="labs-model-benchmark-card">
        <div className="labs-model-benchmark-heading">
          <div>
            <h3>Harness Refiner 08112026</h3>
            <p>
              Tests whether every task uses fewer foreground tokens after an
              evidence-driven Harness update. Quality is measured separately.
              Each run is watched to terminal state with a $10 maximum provider spend.
            </p>
          </div>
          {latest ? (
            <LabStatusBadge
              label={receipt
                ? resultLabel(receipt)
                : stopReceipt
                  ? "Inconclusive"
                  : statusLabel(latest.status)}
              value={receipt
                ? taskEfficiency?.passed ? "succeeded" : "failed"
                : stopReceipt?.terminalClassification ?? latest.status}
            />
          ) : (
            <LabStatusBadge label="Not run" value="not_run" />
          )}
        </div>

        {receipt ? (
          <>
            <EvaluationComparisonCharts
              series={[
                {
                  id: "baseline",
                  label: "Baseline",
                  inputTokens: foregroundUsage!.baseline.inputTokens,
                  outputTokens: foregroundUsage!.baseline.outputTokens,
                  tokens: foregroundUsage!.baseline.totalTokens,
                  passRate: receipt.quality.baselinePassRate,
                  costUsd: foregroundUsage!.baseline.costUsd,
                },
                {
                  id: "candidate",
                  label: "Candidate Harness",
                  inputTokens: foregroundUsage!.candidate.inputTokens,
                  outputTokens: foregroundUsage!.candidate.outputTokens,
                  tokens: foregroundUsage!.candidate.totalTokens,
                  passRate: receipt.quality.candidatePassRate,
                  costUsd: foregroundUsage!.candidate.costUsd,
                },
              ]}
            />
            <div className="labs-model-benchmark-result-row">
              <span>{resultLabel(receipt)}</span>
              <strong>{tokenDelta(receipt)}</strong>
              <button
                className="training-button secondary labs-compact-button"
                type="button"
                onClick={() => latest && onOpenEntry(`model-run:${latest.id}`)}
              >
                View run
              </button>
            </div>
          </>
        ) : stopReceipt ? (
          <div className="labs-model-benchmark-result-row">
            <span>Inconclusive · candidate replay skipped</span>
            <strong>
              {stopReceipt.attempts.length} attempts · ${stopReceipt.budget.observedSpendUsd.toFixed(4)}
            </strong>
            <button
              className="training-button secondary labs-compact-button"
              type="button"
              onClick={() => latest && onOpenEntry(`model-run:${latest.id}`)}
            >
              View run
            </button>
          </div>
        ) : latest ? (
          <button
            className="labs-model-benchmark-running"
            type="button"
            onClick={() => onOpenEntry(`model-run:${latest.id}`)}
          >
            <span>
              {latest.failure
                ?? (latest.evaluationProgress
                  ? `${latest.evaluationProgress.stage.replaceAll("_", " ")} · ${latest.evaluationProgress.completedAttempts}/${latest.evaluationProgress.totalAttempts} attempts`
                  : "The benchmark is running through its pinned stages.")}
            </span>
            <strong>{formatDateTime(latest.updatedAt)}</strong>
          </button>
        ) : (
          <p className="labs-model-benchmark-empty">
            {taskset
              ? "No result yet. The shipped 20-case Taskset is ready."
              : "The built-in Harness Refiner Taskset is loading."}
          </p>
        )}

        {!readOnly ? (
          <div className="labs-model-benchmark-controls">
            <label className="labs-model-benchmark-model">
              <span>Model</span>
              <select
                aria-label="Benchmark model"
                value={chatModelValue(configuredModel)}
                onChange={(event) => {
                  const next = chatModelFromValue(event.target.value);
                  if (next) setConfiguredModel(next);
                }}
              >
                {modelGroups.map((group) => (
                  <optgroup key={group.providerId} label={group.label}>
                    {group.models.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span>Effort</span>
              <select
                value={effort}
                onChange={(event) =>
                  setEffort(event.target.value as CodexReasoningEffort)
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <button
              className="training-button primary"
              disabled={starting || latest?.status === "running"}
              type="button"
              onClick={() => void startBenchmark()}
            >
              {starting ? "Starting…" : "Run Refiner Benchmark"}
            </button>
          </div>
        ) : null}
        </article>
      </div>
    </AppDialog>
  );
}

function evaluationStopReceipt(
  receipt: unknown,
): ModelEvaluationStopReceipt | null {
  return receipt
    && typeof receipt === "object"
    && "schemaVersion" in receipt
    && receipt.schemaVersion === "openpond.modelEvaluationStopReceipt.v1"
      ? receipt as ModelEvaluationStopReceipt
      : null;
}

function evaluationReceipt(
  receipt: unknown,
): ModelEvaluationReceipt | null {
  return receipt
    && typeof receipt === "object"
    && "schemaVersion" in receipt
    && receipt.schemaVersion === "openpond.modelEvaluationReceipt.v1"
      ? receipt as ModelEvaluationReceipt
      : null;
}

function benchmarkModelGroups(
  settings: ProviderSettings | null,
  selected: ChatModelRef,
) {
  const groups = providerOptionsFromSettings(settings, {
    includeUnavailable: false,
  }).flatMap((provider) => {
    const models = modelOptionsForProvider(provider.value, settings).map(
      (model) => ({
        value: chatModelValue({
          providerId: provider.value,
          modelId: model.value,
        }),
        label: model.label,
      }),
    );
    return models.length
      ? [{ providerId: provider.value, label: provider.label, models }]
      : [];
  });
  const selectedValue = chatModelValue(selected);
  if (groups.some((group) => group.models.some((model) => model.value === selectedValue))) {
    return groups;
  }
  return [
    {
      providerId: selected.providerId as ChatProvider,
      label: selected.providerId,
      models: [{
        value: selectedValue,
        label: chatModelLabel(selected.modelId, settings, selected.providerId),
      }],
    },
    ...groups,
  ];
}

function chatModelValue(model: ChatModelRef): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

function chatModelFromValue(value: string): ChatModelRef | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string"
    ) {
      return null;
    }
    return {
      providerId: parsed[0] as ChatModelRef["providerId"],
      modelId: parsed[1],
    };
  } catch {
    return null;
  }
}

function tokenDelta(receipt: ModelEvaluationReceipt) {
  const efficiency = benchmarkTaskEfficiency(receipt);
  const direction = efficiency.tokenDelta > 0 ? "+" : "";
  const percent = efficiency.tokenDeltaPercent === null
    ? ""
    : ` · ${direction}${efficiency.tokenDeltaPercent.toFixed(1)}%`;
  return `${direction}${efficiency.tokenDelta.toLocaleString()} tokens${percent}`;
}

function resultLabel(receipt: ModelEvaluationReceipt) {
  const efficiency = benchmarkTaskEfficiency(receipt);
  return `${efficiency.passedTaskCount}/${efficiency.comparedTaskCount} efficiency passes`;
}
