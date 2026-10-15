import { ErrorToast } from "../common/ErrorToast";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrainingCatalogSchema, type ModelRunPreset } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { connectionQueryScope } from "../../lib/query-scope";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { DropdownSelect } from "../DropdownSelect";
import { TrainingRunSizeControl } from "../training/TrainingRunSizeControl";
import { isTrainingSmoke, type TrainingRunMethod } from "../training/training-run-presets";

type Resources = ReturnType<typeof useChatResourceFocus>;
export function DatasetTrainingPlanFields({
  connection,
  resources,
  onAddToChat,
  initialPreset,
}: {
  connection: ClientConnection;
  resources: Resources;
  initialPreset: ModelRunPreset;
  onAddToChat: (text: string) => void;
}) {
  const [sizing, setSizing] = useState({ prompts: isTrainingSmoke(initialPreset) ? 1 : Math.max(1, resources.focus.dataset?.taskCount ?? 1), rollouts: 4, groups: isTrainingSmoke(initialPreset) ? 1 : Math.max(1, resources.focus.dataset?.taskCount ?? 1), iterations: 2, concurrency: 1 });
  const [preset, setPreset] = useState<ModelRunPreset>(initialPreset);
  const [method, setMethod] = useState<TrainingRunMethod>("grpo"),
    [modelKey, setModelKey] = useState(""),
    [budget, setBudget] = useState("");
  const catalog = useQuery({
    queryKey: ["dataset-training-catalog", connectionQueryScope(connection)],
    queryFn: async () => TrainingCatalogSchema.parse(await api.portableTrainingCatalog(connection)),
  });
  const targets = catalog.data?.targets ?? [],
    target = targets.find((item) => item.destinationId === "openpond_managed");
  const models = (catalog.data?.models ?? []).filter((item) =>
    item.compatibilities.some(
      (choice) =>
        choice.targetId === target?.id &&
        choice.methods.includes(method) &&
        choice.state !== "unsupported",
    ),
  );
  const model = models.find((item) => item.selectionKey === modelKey);
  const methods = (target?.methods ?? []).filter((item) =>
    ["sft", "dpo", "grpo", "ppo"].includes(item),
  );
  useEffect(() => {
    if (catalog.data && methods.length && !methods.includes(method)) {
      const next = methods[0]! as TrainingRunMethod;
      setMethod(next);
      setPreset(current => isTrainingSmoke(current) ? (next === "grpo" || next === "ppo" ? "small_experiment" : "small") : current);
      setModelKey("");
    }
  }, [catalog.data, method]);
  const minimumSpend = target?.approvalPolicy?.minimumSpendUsd ?? 0.01,
    maximumSpend = target?.approvalPolicy?.maximumSpendUsd;
  const amount = Number(budget),
    valid = Boolean(
      target?.available &&
      target.methods.includes(method) &&
      model &&
      budget.trim() &&
      Number.isFinite(amount) &&
      amount >= minimumSpend &&
      (maximumSpend === undefined || amount <= maximumSpend),
    );
  const dataset = resources.focus.dataset;
  const limits = `Use ${sizing.prompts} training prompts, ${sizing.rollouts} rollouts per prompt, ${sizing.groups} rollout groups, ${sizing.iterations} optimizer iterations per group, and concurrency ${sizing.concurrency}. Retain held-out evaluation, tools, grading, checkpoint export, and the existing token/context limits.`;
  const validSizing = Object.values(sizing).every(value => Number.isInteger(value) && value > 0)
    && sizing.prompts <= 100000 && sizing.groups <= 100000 && sizing.iterations >= (method === "grpo" ? 2 : 1) && sizing.iterations <= (method === "grpo" ? 16 : 100)
    && sizing.rollouts >= 2 && sizing.rollouts <= 16 && Number.isInteger(sizing.concurrency) && sizing.concurrency >= 1 && sizing.concurrency <= 16 && sizing.rollouts % sizing.concurrency === 0;
  const canReview = Boolean(dataset && target?.available && model && validSizing);
  const planContext = `using ${method.toUpperCase()} for ${dataset?.name}, revision ${dataset?.revision}, using ${model?.modelId} on OpenPond Managed`;
  return (
    <div className="dataset-training-plan">
      {catalog.error ? (
        <ErrorToast error={catalog.error.message}><button
            type="button"
            className="training-button secondary"
            onClick={() => void catalog.refetch()}
          >
            Retry
          </button></ErrorToast>
      ) : null}
      <TrainingRunSizeControl method={method} methods={(methods.length ? methods : ["grpo"]) as TrainingRunMethod[]}
        onMethodChange={value => {
          setMethod(value);
          setPreset(isTrainingSmoke(preset) ? (value === "grpo" || value === "ppo" ? "small_experiment" : "small") : preset);
          setModelKey("");
        }} value={preset} sizing={sizing} onSizingChange={setSizing}
        onChange={value => {
          setPreset(value);
          if (value !== "custom") setSizing({ prompts: isTrainingSmoke(value) ? 1 : Math.max(1, dataset?.taskCount ?? 1), rollouts: 4, groups: isTrainingSmoke(value) ? 1 : Math.max(1, dataset?.taskCount ?? 1), iterations: 2, concurrency: 1 });
        }} />
      <span className="dataset-training-field-label">Starting model</span>
      <DropdownSelect
        floating
        searchable
        label="Training model"
        value={model?.selectionKey ?? ""}
        options={[
          {
            value: "",
            label: catalog.isPending ? "Loading models…" : "Choose training model",
            disabled: true,
          },
          ...models.map((item) => ({
            value: item.selectionKey,
            label: item.label,
            description: item.reason ?? item.modelId,
          })),
        ]}
        onChange={setModelKey}
        disabled={catalog.isPending}
      />
      <label>
        Maximum spend (USD)
        <div className="training-spend-estimate"><input
          data-autofocus
          type="number"
          min={minimumSpend}
          max={maximumSpend}
          step="0.01"
          aria-label="Maximum training spend"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
        /><button type="button" disabled={!canReview} onClick={() => onAddToChat(
          `Review the training cost ${planContext}. ${limits} Keep this review attached to the selected experiment and inspect the pinned examples, splits, graders, and recipe before estimating. ${valid ? `Use $${amount.toFixed(2)} as the maximum spend.` : "Ask me to choose a hard spend cap before any submission."} Show the current provider estimate or exact quote when supported, its assumptions, what is included, and any separately billed preparation, evaluation, idle, or serving costs. If an estimate is unavailable, explain why and the next step. Do not upload data, start training, or allocate serving capacity.`,
        )}>Review cost in chat</button></div>
      </label>
      <button
        type="button"
        className="training-button"
        disabled={!canReview || !valid}
        onClick={() =>
          onAddToChat(
            `Prepare a training plan ${planContext}, with a maximum spend of $${amount.toFixed(2)}. ${limits} Keep it attached to the selected experiment. Inspect its examples, splits, graders, and data permissions; show the recipe, required changes, and cost for review. Do not upload data or start training.`,
          )
        }
      >
        Prepare in chat
      </button>
    </div>
  );
}
