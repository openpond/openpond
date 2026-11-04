import { canonicalJson, type ExperimentDraft } from "openpond-sdk/training";
import {
  assertLearningContentHash,
  learningRef,
  type TaskBatch,
} from "openpond-sdk/learning";
import { lazy, Suspense, useRef, useState } from "react";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { ModelTrainingSettings } from "../ModelTrainingSettings";
import { WorkspacePanel } from "./WorkspacePanel";
import { EvaluationCard } from "./EvaluationPresentation";
import { ExperimentTypeControl } from "./ExperimentTypeControl";
import { ReleasedDatasetPicker } from "./ReleasedDatasetPicker";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useTrainingExperimentForm } from "./useTrainingExperimentForm";
import { modelsLocation, type ModelsRoute } from "../models-route";
import type { WorkspaceApi } from "./workspace-api";
import { TrainingExperimentComputeCard } from "./TrainingExperimentComputeCard";
import { TrainingExperimentFundingSummary } from "./TrainingExperimentFundingSummary";
import { TrainingUsageQuoteDetails } from "./TrainingUsageQuoteDetails";
import type { DraftNavigationBoundaryHandle } from "../DraftNavigationBoundary";
import { useExperimentSetupTransition } from "./useExperimentSetupTransition";

const ExperimentTrainingDataWorkspace = lazy(
  () => import("./ExperimentTrainingDataWorkspace"),
);

export function TrainingExperimentSetupPanel({
  api,
  method,
  visible,
  navigate,
  onClose,
  onSaveDraft,
  onStarted,
}: {
  api: WorkspaceApi;
  method: "sft" | "grpo";
  visible: boolean;
  navigate: (route: ModelsRoute) => void;
  onClose: () => void;
  onSaveDraft?: (draft: ExperimentDraft) => Promise<unknown>;
  onStarted?: (id: string) => void | Promise<void>;
}) {
  const setup = useEvaluationSetup();
  const [dataOpen, setDataOpen] = useState(false);
  const dataNavigation = useRef<DraftNavigationBoundaryHandle>(null);
  const dataButton = useRef<HTMLButtonElement>(null);
  const form = useTrainingExperimentForm(
    api,
    method,
    visible,
    onClose,
    async (id) => {
      if (onStarted) {
        await onStarted(id);
        return;
      }
      setup.close();
      navigate(
        modelsLocation("runs", null, {
          projectId: api.projectId,
          resourceId: `hosted-run:${id}`,
          detailTab: "details",
        }),
      );
    },
    onSaveDraft,
  );
  const { inputs, locked, receipt } = form;
  useExperimentSetupTransition(
    {
      ...form.guard,
      async requestLeave(action) {
        if (dataOpen && dataNavigation.current)
          await dataNavigation.current.requestLeave(() =>
            form.guard.requestLeave(action),
          );
        else await form.guard.requestLeave(action);
      },
    },
    visible,
  );
  const selected = inputs.models.find(
    (item) =>
      canonicalJson(item.preference) === canonicalJson(setup.trainingBaseModel),
  );
  const datasetSettings =
    form.recipe.dataset && typeof form.recipe.dataset === "object"
      ? (form.recipe.dataset as Record<string, unknown>)
      : {};
  const exampleLimit = datasetSettings.maxExamples;
  const batches = inputs.batches.filter(
    (item) =>
      item.purpose ===
      (method === "sft" ? "supervised_training" : "reward_training"),
  );
  const closeData = () => {
    setDataOpen(false);
    requestAnimationFrame(() => dataButton.current?.focus());
  };
  function selectBatch(batch: (typeof batches)[number]) {
    form.setBatch(batch.reference);
    form.setRecipe({
      ...form.recipe,
      dataset: {
        ...datasetSettings,
        maxExamples: Math.min(
          typeof exampleLimit === "number" && exampleLimit > 0
            ? exampleLimit
            : 1000,
          batch.exampleCount,
          method === "sft" ? 1000 : 100_000,
        ),
      },
    });
  }
  async function useBatch(batch: TaskBatch) {
    form.assertCurrentScope();
    if (form.busy || receipt || !visible)
      throw new Error(
        "Return to the editable experiment before selecting training data.",
      );
    assertLearningContentHash(batch);
    if (
      batch.purpose !==
      (method === "sft" ? "supervised_training" : "reward_training")
    )
      throw new Error(
        "Choose a reviewed batch matching this experiment's training method.",
      );
    selectBatch({
      reference: learningRef(batch),
      rewardBinding: batch.rewardBinding,
      purpose: batch.purpose,
      exampleCount: batch.examples.length,
      sealedAt: batch.sealedAt,
    });
    closeData();
  }
  if (dataOpen)
    return (
      <>
        <Suspense
          fallback={
            <WorkspacePanel
              label="Experiment training data"
              action="experiment"
            >
              <p role="status">Opening training data…</p>
            </WorkspacePanel>
          }
        >
          <ExperimentTrainingDataWorkspace
            key={api.key}
            api={api}
            method={method}
            navigation={dataNavigation}
            onClose={closeData}
            onUseBatch={useBatch}
          />
        </Suspense>
        {form.guard.dialog}
      </>
    );
  return (
    <WorkspacePanel
      label="Experiment setup"
      action="experiment"
      onRequestClose={() => void form.guard.requestLeave(onClose)}
    >
      <header>
        <h2>Run Experiment</h2>
        {onSaveDraft ? (
          <button
            type="button"
            disabled={form.busy}
            onClick={() => void form.guard.requestLeave(onClose)}
          >
            Close setup
          </button>
        ) : null}
      </header>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.perform(
            form.pendingAction ?? (receipt ? "start" : "prepare"),
          );
        }}
      >
        <EvaluationCard title="Starting model">
          <fieldset disabled={locked}>
            <label>
              Model
              <DropdownSelect
                floating
                searchable
                label="Starting model"
                value={
                  (setup.trainingParent || setup.startingModel?.source === "trained" || setup.startingModel?.source === "steering")
                    ? "parent"
                    : (selected?.id ??
                      (setup.trainingBaseModel ? "retained" : ""))
                }
                options={[
                  { value: "", label: "Choose model" },
                  ...((setup.trainingParent || setup.startingModel?.source === "trained" || setup.startingModel?.source === "steering")
                    ? [
                        {
                          value: "parent",
                          label:
                            setup.startingModel?.label ?? form.startingModelLabel ??
                            "Selected trained checkpoint",
                        },
                      ]
                    : []),
                  ...(setup.trainingBaseModel && !selected
                    ? [
                        {
                          value: "retained",
                          label: setup.trainingBaseModel.modelId,
                          disabled: true,
                        },
                      ]
                    : []),
                  ...inputs.models.map((item) => ({
                    value: item.id,
                    label: item.name,
                    disabled: !item.available,
                  })),
                ]}
                onChange={(value) => {
                  if (value === "parent") return;
                  setup.setTrainingParent(null);
                  setup.setTrainingBaseModel(
                    inputs.models.find((item) => item.id === value)
                      ?.preference ?? null,
                  );
                }}
              />
            </label>
            {setup.trainingParent ? (
              <><p>
                Starting from the selected trained checkpoint. The optimizer
                starts fresh.
              </p>
              {method === "grpo" ? <label>LoRA continuation
                <DropdownSelect label="LoRA continuation" floating
                  value={setup.trainingParent.adapterMode}
                  options={[
                    { value: "shared", label: "Shared · update the existing adapter" },
                    { value: "residual_append", label: "Stacked · freeze the parent and add an adapter" },
                    { value: "sequential_merge", label: "Merged · merge the parent, then train a new adapter" },
                  ]}
                  onChange={value => {
                    if (setup.trainingParent && (value === "shared" || value === "residual_append" || value === "sequential_merge"))
                      setup.setTrainingParent({ ...setup.trainingParent, adapterMode: value });
                  }} />
              </label> : null}</>
            ) : null}
            <ExperimentTypeControl disabled={locked} />
          </fieldset>
        </EvaluationCard>
        <EvaluationCard title="Training data">
          <fieldset disabled={locked}>
            <label>
              Reviewed examples
              <DropdownSelect
                label="Reviewed examples"
                floating
                searchable
                value={form.batch ? canonicalJson(form.batch) : ""}
                options={[
                  { value: "", label: "Choose reviewed batch" },
                  ...(form.batch &&
                  !batches.some(
                    (item) =>
                      canonicalJson(item.reference) ===
                      canonicalJson(form.batch),
                  )
                    ? [
                        {
                          value: canonicalJson(form.batch),
                          label: `${form.batch.id} · r${form.batch.revision}`,
                          disabled: true,
                        },
                      ]
                    : []),
                  ...batches.map((item) => ({
                    value: canonicalJson(item.reference),
                    label: `${item.exampleCount} example${item.exampleCount === 1 ? "" : "s"} · ${item.reference.id} · r${item.reference.revision}`,
                  })),
                ]}
                onChange={(value) => {
                  const batch = batches.find(
                    (item) => canonicalJson(item.reference) === value,
                  );
                  if (batch) selectBatch(batch);
                  else form.setBatch(null);
                }}
              />
            </label>
            {form.selectedBatch ? (
              <p>
                {form.selectedBatch.exampleCount} reviewed example
                {form.selectedBatch.exampleCount === 1 ? "" : "s"}.{" "}
                {method === "sft" ? "Supervised targets" : "Reward binding"}{" "}
                retained with this batch.
              </p>
            ) : null}
            {inputs.hasNextPage ? (
              <button
                type="button"
                className="training-text-button"
                disabled={inputs.isFetchingNextPage}
                onClick={() => void inputs.fetchNextPage()}
              >
                More reviewed batches
              </button>
            ) : null}
            <button
              type="button"
              className="training-text-button"
              ref={dataButton}
              onClick={() => setDataOpen(true)}
            >
              Import or review data
            </button>
          </fieldset>
        </EvaluationCard>
        <EvaluationCard title="Validation">
          <fieldset disabled={locked}>
            <ReleasedDatasetPicker
              api={api}
              value={form.evaluation}
              onChange={form.setEvaluation}
              disabled={locked}
            />
            <label>
              Optimizer validation split
              <DropdownSelect
                label="Optimizer validation split"
                floating
                value={form.validationSplit}
                options={[
                  { value: "validation", label: "Validation" },
                  { value: "frozen_eval", label: "Frozen evaluation" },
                ]}
                onChange={(value) =>
                  form.setValidationSplit(value as typeof form.validationSplit)
                }
              />
            </label>
            <p>
              This split is visible during optimization. Keep independent
              acceptance holdouts separate.
            </p>
          </fieldset>
        </EvaluationCard>
        <EvaluationCard title="Training settings">
          <fieldset disabled={locked}>
            <label>
              Training examples
              <input
                type="number"
                min={1}
                max={Math.min(
                  form.selectedBatch?.exampleCount ?? 100_000,
                  method === "sft" ? 1000 : 100_000,
                )}
                step={1}
                value={
                  typeof exampleLimit === "number" ||
                  typeof exampleLimit === "string"
                    ? exampleLimit
                    : ""
                }
                onChange={(event) =>
                  form.setRecipe({
                    ...form.recipe,
                    dataset: {
                      ...datasetSettings,
                      maxExamples:
                        event.target.value === ""
                          ? ""
                          : event.target.valueAsNumber,
                    },
                  })
                }
              />
            </label>
            <ModelTrainingSettings
              recipe={form.recipe}
              onChange={(value) => {
                if (value) form.setRecipe(value);
              }}
            />
            <details>
              <summary>Run details</summary>
              <label>
                Name
                <input
                  value={form.name}
                  onChange={(event) => form.setName(event.target.value)}
                  maxLength={191}
                />
              </label>
            </details>
          </fieldset>
        </EvaluationCard>
        <TrainingExperimentComputeCard
          compute={form.compute}
          selection={form.gpuSelection}
          onChange={form.setGpuSelection}
          locked={locked}
          method={method}
          budget={form.budget}
          onBudgetChange={form.setBudget}
          actualUsage={form.funding.allocationAdmission}
          actualUsageAvailable={inputs.billingModes?.[1].availability === "requires_preparation"}
          onBillingModeChange={form.setBillingMode}
          customerCapUsd={form.customerCapUsd}
          onCustomerCapChange={form.setCustomerCapUsd}
          prepared={receipt?.state === "prepared"}
          startAttempted={form.startAttempted}
          busy={form.busy}
        >
          <TrainingExperimentFundingSummary
            funding={form.funding}
            busy={form.busy}
            startAttempted={form.startAttempted}
            billingReturnPending={form.billingReturnPending}
            onOpenBilling={form.openBilling}
            onRefresh={form.refreshCredits}
          />
        </TrainingExperimentComputeCard>
        {form.canRecover ? (
          <EvaluationCard title="Previous training review">
            <p>
              {form.recovery.data?.review?.request.name}
              {form.recovery.data?.review?.request.usageFunding
                ? form.recovery.data.review.request.usageFunding.customerCapUsd === null
                  ? " · Use available credits"
                  : ` · $${form.recovery.data.review.request.usageFunding.customerCapUsd} spending limit`
                : ` · $${form.recovery.data?.review?.request.maximumSpendUsd} maximum spend`}
            </p>
            <p>
              The original request is retained on this device. Restore it to
              check the current preparation or existing run.
            </p>
            <button
              type="button"
              className="training-button secondary"
              disabled={form.busy}
              onClick={() =>
                void form.guard.requestLeave(() => form.perform("recover"))
              }
            >
              Restore previous review
            </button>
          </EvaluationCard>
        ) : null}
        {receipt ? (
          <EvaluationCard title="Reviewed experiment">
            <p>
              {receipt.plan.request.name}
              {!receipt.plan.usageQuote ? ` · $${receipt.plan.request.maximumSpendUsd} maximum spend` : null}
            </p>
            {receipt.plan.usageQuote ? <TrainingUsageQuoteDetails quote={receipt.plan.usageQuote} /> : null}
            <p>
              {receipt.state === "submitted"
                ? "This experiment already has a training Job."
                : receipt.state === "cancelled"
                  ? "Preparation cancelled. Finish editing to prepare another run."
                  : "Start training submits this preparation to hosted execution."}
            </p>
            <details>
              <summary>Exact inputs</summary>
              <pre>{JSON.stringify(receipt.plan.source, null, 2)}</pre>
            </details>
          </EvaluationCard>
        ) : null}
        {form.error || inputs.error ? (
          <ErrorToast error={form.error ?? inputs.error} />
        ) : null}
        {form.recovery.isError ? (
          <button
            type="button"
            className="training-text-button"
            disabled={form.busy}
            onClick={() => void form.recovery.refetch()}
          >
            Reload retained reviews
          </button>
        ) : null}
        {inputs.error ? (
          <button
            className="training-text-button"
            type="button"
            onClick={() => void inputs.refetch()}
          >
            Reload training inputs
          </button>
        ) : null}
        {inputs.isPending ? (
          <p role="status">Loading training inputs…</p>
        ) : null}
        {form.recoveredJobId ? (
          <button
            type="button"
            className="training-button secondary"
            disabled={form.busy}
            onClick={() => void form.openRecoveredJob()}
          >
            Open existing training run
          </button>
        ) : null}
        {form.recoveredJobId ? (
          <button
            type="button"
            className="training-button secondary"
            disabled={form.busy}
            onClick={() => void form.perform("prepare", { newRun: true })}
          >
            Review edited settings for a new run
          </button>
        ) : null}
        {form.saveDraft ? (
          <button
            type="button"
            className="training-button secondary"
            disabled={locked}
            onClick={() => void form.saveDraft?.()}
          >
            Save draft
          </button>
        ) : null}
        <button
          className="training-button"
          type="submit"
          disabled={
            form.busy ||
            !form.recovery.isSuccess ||
            form.requiresRecovery ||
            Boolean(form.recoveredJobId) ||
            receipt?.state === "cancelled" ||
            (receipt?.state === "prepared" &&
              form.pendingAction !== "cancel" &&
              !form.startAttempted &&
              (!form.compute.canStart ||
                !form.funding.canStart ||
                form.billingReturnPending))
          }
        >
          {form.busy
            ? "Working…"
            : form.pendingAction === "cancel"
              ? "Retry edit setup"
              : receipt?.state === "submitted"
                ? "Open training run"
                : receipt
                  ? form.startAttempted
                    ? "Retry start"
                    : "Start training"
                  : "Review experiment"}
        </button>
        {receipt ? (
          <button
            type="button"
            className="training-button secondary"
            disabled={
              form.busy ||
              Boolean(form.pendingAction) ||
              receipt.state === "submitted"
            }
            onClick={() => void form.perform("cancel")}
          >
            Edit setup
          </button>
        ) : null}
      </form>
      {form.guard.dialog}
    </WorkspacePanel>
  );
}
