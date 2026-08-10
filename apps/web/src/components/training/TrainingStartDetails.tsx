import {
  type RftLossMethod,
  type TrainingCatalog,
  type TrainingPreparedStart,
} from "@openpond/contracts";
import {
  trainingMethodLabel,
  trainingMethodName,
} from "./training-model-data";
import {
  destinationLabel,
  formatBytes,
  modelLabel,
  rftLossLabel,
} from "./training-start-view-helpers";

type TrainingMethod = "sft" | "dpo" | "grpo" | "ppo";
type TrainingTarget = TrainingCatalog["targets"][number];

export function TrainingMethodTabs({
  busy,
  method,
  options,
  onSelect,
}: {
  busy: boolean;
  method: TrainingMethod;
  options: TrainingMethod[];
  onSelect: (method: TrainingMethod) => void;
}) {
  return (
    <div
      className="training-method-tabs"
      role="tablist"
      aria-label="Training method"
    >
      {options.map((candidate) => (
        <button
          aria-selected={candidate === method}
          className={candidate === method ? "active" : ""}
          disabled={busy}
          key={candidate}
          role="tab"
          type="button"
          onClick={() => onSelect(candidate)}
        >
          <span>{trainingMethodName(candidate)}</span>
          <strong>{trainingMethodLabel(candidate)}</strong>
        </button>
      ))}
    </div>
  );
}

export function TrainingStartSummary({
  method,
  trainingExamples,
  availableTrainExamples,
  approvedExamples,
  evaluationExamples,
  preparedQuote,
  selectedComputeTarget,
  approvalPresentation,
  maximumCostUsd,
  providerManaged,
  storagePath,
}: {
  method: TrainingMethod;
  trainingExamples: number;
  availableTrainExamples: number;
  approvedExamples: number;
  evaluationExamples: number;
  preparedQuote: number | null;
  selectedComputeTarget: TrainingTarget | null;
  approvalPresentation: "inline" | "dialog";
  maximumCostUsd: number | null;
  providerManaged: boolean;
  storagePath: string | null;
}) {
  const approvalPolicy = selectedComputeTarget?.approvalPolicy ?? null;
  const trainingData =
    method === "grpo" || method === "ppo"
      ? `${Math.min(trainingExamples, availableTrainExamples)} of ${availableTrainExamples} approved train prompts`
      : method === "dpo"
        ? `${Math.min(trainingExamples, approvedExamples)} of ${approvedExamples} approved preference pairs`
        : `${Math.min(trainingExamples, approvedExamples || availableTrainExamples)} approved example${trainingExamples === 1 ? "" : "s"}`;
  const estimate = approvalPolicy
        ? approvalPresentation === "dialog"
          ? "Reviewed when you Run"
          : preparedQuote == null
            ? `Prepare a provider-validated quote · hard cap $${maximumCostUsd != null && Number.isFinite(maximumCostUsd) ? maximumCostUsd.toFixed(2) : "—"}`
            : `$${preparedQuote.toFixed(2)} · hard cap $${(maximumCostUsd ?? 0).toFixed(2)}`
        : "Provided before approval";
  return (
    <dl className="training-start-summary">
      <div>
        <dt>Training data</dt>
        <dd>{trainingData}</dd>
      </div>
      <div>
        <dt>Evaluation</dt>
        <dd>
          {evaluationExamples} test example
          {evaluationExamples === 1 ? "" : "s"}
        </dd>
      </div>
      <div>
        <dt>{preparedQuote == null ? "Estimate" : "Exact quote"}</dt>
        <dd>{estimate}</dd>
      </div>
      <div>
        <dt>Storage</dt>
        <dd>
          {providerManaged
            ? "Portable output imported into app-managed storage"
            : storagePath ?? "App-managed storage"}
        </dd>
      </div>
    </dl>
  );
}

export function TrainingPreparedConfirmation({
  prepared,
  preparedQuote,
  maximumCostUsd,
}: {
  prepared: TrainingPreparedStart;
  preparedQuote: number | null;
  maximumCostUsd: number | null;
}) {
  const recipe = prepared.plan.recipe;
  const modelId = recipe.method === "dpo"
    ? recipe.policyModel.id
    : recipe.method === "ppo"
      ? recipe.policyOptimization.policyModel.id
      : recipe.method === "sft" || recipe.method === "grpo"
        ? recipe.baseModel.id
        : "";
  const methodLabel = recipe.method === "grpo"
    ? `RFT · ${rftLossLabel(recipe.loss.method)}`
    : `${trainingMethodLabel(recipe.method)} · ${recipe.parameterization.toUpperCase()}`;
  return (
    <section
      className="training-prepared-confirmation"
      aria-label="Confirm paid training launch"
    >
      <div>
        <strong>Ready to launch</strong>
        <span>The quote and prepared data are fixed to this confirmation.</span>
      </div>
      <dl className="training-start-summary">
        <div>
          <dt>Account</dt>
          <dd>{prepared.approvalActor ?? "Local user"}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{destinationLabel(prepared.plan.destinationId)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{modelLabel(modelId)}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{methodLabel}</dd>
        </div>
        <div>
          <dt>Quote</dt>
          <dd>
            {preparedQuote == null
              ? "Unavailable"
              : `$${preparedQuote.toFixed(2)}`}
          </dd>
        </div>
        <div>
          <dt>Maximum</dt>
          <dd>
            {maximumCostUsd == null
              ? "Unavailable"
              : `$${maximumCostUsd.toFixed(2)}`}
          </dd>
        </div>
        <div>
          <dt>Retention</dt>
          <dd>{prepared.plan.dataPolicy.retentionDays} days</dd>
        </div>
        <div>
          <dt>Prepared data</dt>
          <dd>{formatBytes(prepared.bundle.totalSizeBytes)} · verified</dd>
        </div>
      </dl>
      <p>No provider dataset or job exists until you launch.</p>
    </section>
  );
}

export function TrainingAdvancedSettings({
  method,
  trainingExamples,
  maximumTrainingExamples,
  maxSteps,
  sequenceLength,
  maximumSequenceLength,
  rolloutMaxOutputTokens,
  maximumOutputTokens,
  defaultRolloutOutputTokens,
  rank,
  learningRate,
  rftLossMethod,
  rolloutGroupSize,
  rolloutConcurrency,
  onTrainingExamplesChange,
  onMaxStepsChange,
  onSequenceLengthChange,
  onRolloutMaxOutputTokensChange,
  onRankChange,
  onLearningRateChange,
  onRftLossMethodChange,
  onRolloutGroupSizeChange,
  onRolloutConcurrencyChange,
}: {
  method: TrainingMethod;
  trainingExamples: number;
  maximumTrainingExamples: number;
  maxSteps: number;
  sequenceLength: number;
  maximumSequenceLength: number;
  rolloutMaxOutputTokens: number;
  maximumOutputTokens: number;
  defaultRolloutOutputTokens: number;
  rank: number;
  learningRate: number;
  rftLossMethod: RftLossMethod;
  rolloutGroupSize: number;
  rolloutConcurrency: number;
  onTrainingExamplesChange: (value: number) => void;
  onMaxStepsChange: (value: number) => void;
  onSequenceLengthChange: (value: number) => void;
  onRolloutMaxOutputTokensChange: (value: number) => void;
  onRankChange: (value: number) => void;
  onLearningRateChange: (value: number) => void;
  onRftLossMethodChange: (value: RftLossMethod) => void;
  onRolloutGroupSizeChange: (value: number) => void;
  onRolloutConcurrencyChange: (value: number) => void;
}) {
  return (
    <details className="training-start-advanced">
      <summary>Advanced settings</summary>
      <div className="training-start-fields">
        <label>
          <span>Training examples</span>
          <input
            type="number"
            min={1}
            max={maximumTrainingExamples}
            value={trainingExamples}
            onChange={(event) =>
              onTrainingExamplesChange(
                Math.max(
                  1,
                  Math.min(
                    maximumTrainingExamples,
                    event.target.valueAsNumber || 1,
                  ),
                ),
              )}
          />
        </label>
        <label>
          <span>Optimizer steps</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxSteps}
            onChange={(event) =>
              onMaxStepsChange(event.target.valueAsNumber || 1)}
          />
        </label>
        <label>
          <span>
            {method === "grpo" ? "Prompt length" : "Sequence length"}
          </span>
          <input
            type="number"
            min={16}
            max={maximumSequenceLength}
            value={sequenceLength}
            onChange={(event) =>
              onSequenceLengthChange(event.target.valueAsNumber || 64)}
          />
        </label>
        {method === "grpo" ? (
          <label>
            <span>Maximum output</span>
            <input
              type="number"
              min={16}
              max={maximumOutputTokens}
              value={rolloutMaxOutputTokens}
              onChange={(event) =>
                onRolloutMaxOutputTokensChange(
                  Math.max(
                    16,
                    Math.min(
                      maximumOutputTokens,
                      event.target.valueAsNumber
                        || defaultRolloutOutputTokens,
                    ),
                  ),
                )}
            />
          </label>
        ) : null}
        <label>
          <span>LoRA rank</span>
          <input
            type="number"
            min={1}
            max={256}
            value={rank}
            onChange={(event) =>
              onRankChange(event.target.valueAsNumber || 2)}
          />
        </label>
        <label>
          <span>Learning rate</span>
          <input
            type="number"
            min={0.000001}
            max={0.1}
            step={0.0001}
            value={learningRate}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value)) onLearningRateChange(value);
            }}
          />
        </label>
        {method === "grpo" ? (
          <>
            <label>
              <span>RL loss</span>
              <select
                aria-label="RL loss"
                value={rftLossMethod}
                onChange={(event) =>
                  onRftLossMethodChange(
                    event.target.value as RftLossMethod,
                  )}
              >
                <option value="dapo">DAPO</option>
                <option value="grpo">GRPO</option>
                <option value="gspo-token">GSPO-token</option>
              </select>
            </label>
            <label>
              <span>Rollouts per prompt</span>
              <input
                type="number"
                min={2}
                max={16}
                value={rolloutGroupSize}
                onChange={(event) =>
                  onRolloutGroupSizeChange(
                    event.target.valueAsNumber || 8,
                  )}
              />
            </label>
            <label>
              <span>Concurrent rollouts</span>
              <input
                type="number"
                min={1}
                max={16}
                value={rolloutConcurrency}
                onChange={(event) =>
                  onRolloutConcurrencyChange(
                    event.target.valueAsNumber || 4,
                  )}
              />
            </label>
          </>
        ) : null}
      </div>
    </details>
  );
}
