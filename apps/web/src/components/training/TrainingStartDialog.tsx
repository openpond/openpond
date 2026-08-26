import { useEffect, useRef } from "react";
import type { TrainingDestinationId } from "@openpond/contracts";
import { X } from "../icons";
import { TrainingCatalogSetup } from "./TrainingCatalogSetup";
import { TrainingProviderApprovalDialog } from "./TrainingProviderApprovalDialog";
import { TrainingProviderApprovalFields } from "./TrainingProviderApprovalFields";
import {
  TrainingAdvancedSettings,
  TrainingMethodTabs,
  TrainingPreparedConfirmation,
  TrainingStartSummary,
} from "./TrainingStartDetails";
import { recommendedSequenceLength } from "./training-start-defaults";
import { preserveBaseModelSelection, trainingRecipe } from "./training-start-recipe";
import {
  defaultLearningRate,
  destinationLabel,
  trainingSplitCount,
} from "./training-start-view-helpers";
import { useTrainingCatalogState } from "./useTrainingCatalogState";
import { useTrainingStartForm } from "./useTrainingStartForm";
import type { TrainingStartApproval, TrainingStartDialogProps } from "./training-start-types";

const DEFAULT_MAXIMUM_SEQUENCE_LENGTH = 4_096;
const DEFAULT_MAXIMUM_OUTPUT_TOKENS = 4_096;
const DEFAULT_ROLLOUT_OUTPUT_TOKENS = 64;

export type { TrainingStartApproval } from "./training-start-types";

export {
  defaultRftLossMethod,
  preserveBaseModelSelection,
  trainingRecipe,
} from "./training-start-recipe";

export function TrainingStartDialog({
  baseModelCandidates,
  connection,
  taskset,
  learnedPreferenceReward = null,
  modelId = null,
  destinations,
  initialMethod,
  preferredBaseModel = null,
  busy,
  onClose,
  onStart,
  onPrepare,
  onConfirmPrepared,
  onOpenProviderSettings,
  presentation = "dialog",
  runControlId,
  hideActions = false,
  onReadinessChange,
  onConfigurationChange,
  runPreset = "custom",
  hideMethodTabs = false,
  approvalPresentation = "inline",
  configurationContent,
}: TrainingStartDialogProps) {
  const {
    primaryMethod,
    bootstrap,
    methodOptions,
    quickTest,
    initialDestination,
    availableTrainExamples,
    destinationId,
    setDestinationId,
    baseModelKey,
    setBaseModelKey,
    maxSteps,
    setMaxSteps,
    trainingExamples,
    setTrainingExamples,
    sequenceLength,
    setSequenceLength,
    rank,
    setRank,
    learningRate,
    setLearningRate,
    klBeta,
    setKlBeta,
    exportApproved,
    setExportApproved,
    maximumCostUsd,
    setMaximumCostUsd,
    retentionDays,
    setRetentionDays,
    rolloutGroupSize,
    setRolloutGroupSize,
    rolloutConcurrency,
    setRolloutConcurrency,
    rolloutMaxOutputTokens,
    setRolloutMaxOutputTokens,
    rftLossMethod,
    setRftLossMethod,
    method,
    setMethod,
    prepared,
    setPrepared,
    providerApprovalOpen,
    setProviderApprovalOpen,
  } = useTrainingStartForm({
    baseModelCandidates,
    preferredBaseModel,
    destinations,
    taskset,
    initialMethod,
    runPreset,
  });
  const {
    catalog,
    catalogError,
    catalogTargets,
    visibleCatalogModels,
    computeTargetId,
    modelSearch,
    setModelSearch,
  } = useTrainingCatalogState({
    connection,
    destinations,
    initialDestination,
    method,
  });
  const destination = destinations.find((item) => item.destinationId === destinationId) ?? null;
  const isBootstrap = method === "sft" && primaryMethod !== "sft" && bootstrap?.method === "sft";
  const approvedExamples =
    method === "dpo"
      ? taskset.learningSignals.preferences.filter((pair) => pair.approved).length
      : taskset.learningSignals.demonstrations.filter((example) => example.approved).length;
  const evaluationExamples = trainingSplitCount(taskset, "frozen_eval");
  const selectedBaseModel =
    baseModelCandidates.find((candidate) => candidate.selectionKey === baseModelKey) ?? null;
  const selectedExecutionOption =
    selectedBaseModel?.executionOptions.find(
      (option) => option.destinationId === destinationId && option.methods.includes(method),
    ) ?? null;
  const baseModelId = selectedBaseModel?.preference.modelId ?? "";
  const selectedComputeTarget =
    catalogTargets.find((target) => target.id === computeTargetId) ?? null;
  const initializedTargetDefaultsRef = useRef<string | null>(null);
  const selectedCatalogModel =
    catalog?.models.find((model) => model.selectionKey === baseModelKey) ?? null;
  const selectedCatalogCompatibility =
    selectedCatalogModel?.compatibilities.find(
      (compatibility) =>
        compatibility.targetId === selectedComputeTarget?.id &&
        compatibility.methods.includes(method),
    ) ?? null;
  const approvalPolicy = selectedComputeTarget?.approvalPolicy ?? null;
  const providerManaged = selectedComputeTarget?.executionMode === "provider_native";
  const providerLabel = approvalPolicy?.providerLabel ?? "provider";

  useEffect(() => {
    if (
      !selectedComputeTarget ||
      selectedComputeTarget.destinationId !== destinationId
    ) {
      return;
    }
    const key = JSON.stringify({
      destinationId: selectedComputeTarget.destinationId,
      defaults: selectedComputeTarget.defaults,
      approvalPolicy: selectedComputeTarget.approvalPolicy,
    });
    if (initializedTargetDefaultsRef.current === key) return;
    initializedTargetDefaultsRef.current = key;
    setRank(selectedComputeTarget.defaults.loraRank);
    setRolloutGroupSize(selectedComputeTarget.defaults.rolloutGroupSize);
    setRolloutConcurrency(selectedComputeTarget.defaults.rolloutConcurrency);
    setRolloutMaxOutputTokens(selectedComputeTarget.defaults.rolloutOutputTokens);
    setMaxSteps(selectedComputeTarget.defaults.maxSteps);
    setMaximumCostUsd(
      selectedComputeTarget.approvalPolicy?.defaultMaximumSpendUsd ?? null,
    );
    setRetentionDays(
      selectedComputeTarget.approvalPolicy?.defaultRetentionDays ?? 7,
    );
    if (selectedComputeTarget.destinationId === "openpond_managed") {
      setLearningRate(0.00001);
      setSequenceLength(4_096);
    }
  }, [
    destinationId,
    selectedComputeTarget,
    setLearningRate,
    setMaxSteps,
    setMaximumCostUsd,
    setRank,
    setRetentionDays,
    setRolloutConcurrency,
    setRolloutGroupSize,
    setRolloutMaxOutputTokens,
    setSequenceLength,
  ]);
  const maximumSequenceLength =
    selectedComputeTarget?.limits.maximumSequenceLength ?? DEFAULT_MAXIMUM_SEQUENCE_LENGTH;
  const maximumOutputTokens =
    selectedComputeTarget?.limits.maximumOutputTokens ?? DEFAULT_MAXIMUM_OUTPUT_TOKENS;
  const maximumTrainingExamples =
    method === "dpo"
      ? Math.max(1, taskset.learningSignals.preferences.filter((pair) => pair.approved).length)
      : method === "ppo"
        ? Math.max(1, Math.min(1_000, availableTrainExamples))
        : method === "grpo" && providerManaged && taskset.datasetArtifact
          ? Math.max(
              1,
              Math.min(
                selectedComputeTarget?.limits.maximumTrainingExamples ?? availableTrainExamples,
                availableTrainExamples,
              ),
            )
          : Math.max(1, Math.min(100_000, availableTrainExamples));
  const approvalReady =
    !approvalPolicy ||
    ((!approvalPolicy.exportApprovalRequired || exportApproved) &&
      maximumCostUsd != null &&
      maximumCostUsd >= approvalPolicy.minimumSpendUsd &&
      maximumCostUsd <= approvalPolicy.maximumSpendUsd &&
      Number.isInteger(retentionDays) &&
      retentionDays >= approvalPolicy.minimumRetentionDays &&
      retentionDays <= approvalPolicy.maximumRetentionDays);
  const executableMethod =
    selectedComputeTarget?.methods.includes(method) ??
    destination?.methods.includes(method as never) ??
    false;
  const tasksetMethodCompatible =
    taskset.capabilities.compatibleMethods.includes(method as never) ||
    bootstrap?.method === method;
  const configurationCompatible = Boolean(
    taskset.readiness?.ready &&
    executableMethod &&
    destination?.available &&
    destination.methods.includes(method as never) &&
    tasksetMethodCompatible &&
    selectedExecutionOption?.available &&
    selectedCatalogCompatibility?.state !== "unsupported" &&
    selectedCatalogCompatibility?.state !== "compute_setup_required" &&
    selectedBaseModel?.preference.source !== "local",
  );
  const compatible = configurationCompatible && approvalReady;
  const configurationIncompatibility = !taskset.readiness?.ready
    ? "The Taskset must pass environment, grader, and data readiness before training."
    : !executableMethod
      ? `${method.toUpperCase()} is the primary recommendation but no compatible execution backend is available here.${bootstrap ? " Choose the optional SFT trajectory bootstrap to run the local precursor." : ""}`
      : selectedCatalogCompatibility?.state === "unsupported" ||
          selectedCatalogCompatibility?.state === "compute_setup_required"
        ? (selectedCatalogCompatibility.reason ??
          "The selected Model and compute target are not ready.")
        : !selectedBaseModel
          ? `Choose starting weights compatible with ${destinationLabel(destinationId)} and ${method.toUpperCase()}.`
          : !selectedExecutionOption?.available
            ? (selectedExecutionOption?.unavailableReason ??
              "The selected base model cannot run on this compute destination.")
            : !destination?.methods.includes(method as never)
                ? `${destinationLabel(destinationId)} does not execute ${method.toUpperCase()}.`
                : (destination?.unavailableReason ?? null);
  const launchIncompatibility =
    configurationIncompatibility ??
    (approvalPolicy?.exportApprovalRequired && !exportApproved
      ? `Approve the bounded train-split export before launching ${providerLabel}.`
      : approvalPolicy &&
          (maximumCostUsd == null ||
            maximumCostUsd < approvalPolicy.minimumSpendUsd ||
            maximumCostUsd > approvalPolicy.maximumSpendUsd)
        ? `Set a ${providerLabel} cap from $${approvalPolicy.minimumSpendUsd.toFixed(2)} through $${approvalPolicy.maximumSpendUsd.toFixed(2)}.`
        : approvalPolicy &&
            (!Number.isInteger(retentionDays) ||
              retentionDays < approvalPolicy.minimumRetentionDays ||
              retentionDays > approvalPolicy.maximumRetentionDays)
          ? "Choose a provider retention record from 1 through 30 days."
          : null);
  const recipe = trainingRecipe({
    method,
    taskset,
    destinationId,
    baseModelId,
    maxSteps,
    sequenceLength,
    rank,
    learningRate,
    klBeta,
    rolloutGroupSize,
    rolloutConcurrency,
    rolloutMaxOutputTokens,
    trainingExamples,
    rftLossMethod,
    executionMode: selectedComputeTarget?.executionMode,
    catalogModel: selectedCatalogModel,
    learnedPreferenceReward,
  });
  const approval: TrainingStartApproval = {
    exportApproved: approvalPolicy ? exportApproved : true,
    maximumCostUsd: approvalPolicy ? maximumCostUsd : 0,
    retentionDays: approvalPolicy ? retentionDays : null,
    region: null,
  };
  const configurationKey = JSON.stringify({
    modelId,
    destinationId,
    recipe,
    approval,
  });
  const currentPrepared = prepared?.configurationKey === configurationKey ? prepared.value : null;

  async function performStart() {
    if (!compatible) return;
    if (approvalPolicy?.preparationRequired && !currentPrepared) {
      const next = await onPrepare(destinationId, recipe, approval);
      if (next) setPrepared({ configurationKey, value: next });
      return;
    }
    const completed =
      approvalPolicy?.preparationRequired && currentPrepared
        ? await onConfirmPrepared(currentPrepared, maximumCostUsd ?? 0)
        : await onStart(destinationId, recipe, approval);
    if (completed) {
      setProviderApprovalOpen(false);
      onClose();
    }
  }

  async function start() {
    if (!configurationCompatible) return;
    if (approvalPolicy && approvalPresentation === "dialog") {
      setProviderApprovalOpen(true);
      return;
    }
    await performStart();
  }

  function selectDestination(
    next: TrainingDestinationId,
    target = catalogTargets.find((candidate) => candidate.destinationId === next),
  ) {
    setDestinationId(next);
    setBaseModelKey((current) =>
      preserveBaseModelSelection(baseModelCandidates, current, next, method),
    );
    setRank(target?.defaults.loraRank ?? 2);
    setRolloutGroupSize(target?.defaults.rolloutGroupSize ?? 4);
    setRolloutConcurrency(target?.defaults.rolloutConcurrency ?? 1);
    setRolloutMaxOutputTokens(
      target?.defaults.rolloutOutputTokens ?? DEFAULT_ROLLOUT_OUTPUT_TOKENS,
    );
    setLearningRate(
      next === "openpond_managed"
        ? 0.00001
        : defaultLearningRate(baseModelId),
    );
    setMaximumCostUsd(target?.approvalPolicy?.defaultMaximumSpendUsd ?? null);
    setRetentionDays(target?.approvalPolicy?.defaultRetentionDays ?? 7);
    setExportApproved(false);
    if (method === "grpo") {
      setMaxSteps(target?.defaults.maxSteps ?? 8);
      if (taskset.datasetArtifact && target?.executionMode === "provider_native") {
        setTrainingExamples(
          Math.max(
            1,
            Math.min(availableTrainExamples, target.limits.maximumTrainingExamples ?? 16),
          ),
        );
      }
      setSequenceLength(
        Math.min(
          target?.limits.maximumSequenceLength ?? DEFAULT_MAXIMUM_SEQUENCE_LENGTH,
          Math.max(512, recommendedSequenceLength(taskset, target?.limits.maximumSequenceLength)),
        ),
      );
    } else {
      setSequenceLength(recommendedSequenceLength(taskset, target?.limits.maximumSequenceLength));
    }
  }

  function selectMethod(next: "sft" | "dpo" | "grpo" | "ppo") {
    setMethod(next);
    setPrepared(null);
    setBaseModelKey((current) =>
      preserveBaseModelSelection(baseModelCandidates, current, destinationId, next),
    );
    if (next === "grpo") {
      setMaxSteps(8);
      if (providerManaged && taskset.datasetArtifact) {
        setSequenceLength((current) => Math.max(512, current));
      }
      setTrainingExamples(
        Math.max(1, Math.min(availableTrainExamples, taskset.datasetArtifact ? 16 : 1_000)),
      );
      return;
    }
    setMaxSteps(quickTest ? 1 : next === "dpo" ? 4 : next === "ppo" ? 2 : 2);
    if (next === "dpo") {
      setTrainingExamples(
        Math.max(
          1,
          Math.min(
            taskset.learningSignals.preferences.filter((pair) => pair.approved).length,
            quickTest ? 2 : 64,
          ),
        ),
      );
      return;
    }
    if (next === "ppo") {
      setTrainingExamples(Math.max(1, Math.min(availableTrainExamples, quickTest ? 2 : 4)));
      return;
    }
    setTrainingExamples(Math.max(1, Math.min(availableTrainExamples, quickTest ? 4 : 32)));
  }
  const preparedQuote = currentPrepared?.plan.estimatedCostUsd ?? null;
  const actionLabel = busy
    ? currentPrepared
      ? "Launching…"
      : approvalPolicy?.preparationRequired
        ? "Preparing…"
        : "Starting…"
    : currentPrepared && preparedQuote != null
      ? `Launch $${preparedQuote.toFixed(2)} job`
      : approvalPolicy?.preparationRequired
        ? "Prepare exact quote"
        : "Start training";
  const readinessCompatible =
    approvalPresentation === "dialog" && approvalPolicy ? configurationCompatible : compatible;
  const readinessActionLabel =
    approvalPresentation === "dialog" && approvalPolicy ? "Run" : actionLabel;

  useEffect(() => {
    if (selectedComputeTarget) {
      selectDestination(
        selectedComputeTarget.destinationId as TrainingDestinationId,
        selectedComputeTarget,
      );
    }
  }, [selectedComputeTarget?.id, selectedComputeTarget?.destinationId]);

  useEffect(() => {
    onReadinessChange?.({
      ready: readinessCompatible,
      reason: readinessCompatible
        ? null
        : approvalPresentation === "dialog" && approvalPolicy
          ? (configurationIncompatibility ?? "This setup is unavailable.")
          : (launchIncompatibility ?? "This setup is unavailable."),
      actionLabel: readinessActionLabel,
    });
  }, [
    approvalPresentation,
    configurationIncompatibility,
    approvalPolicy,
    launchIncompatibility,
    onReadinessChange,
    readinessActionLabel,
    readinessCompatible,
  ]);

  useEffect(() => {
    onConfigurationChange?.({
      baseModel: selectedBaseModel?.preference ?? null,
      method,
      destinationId,
      recipe,
      approval,
    });
  }, [configurationKey, onConfigurationChange]);

  const providerApprovalFields = approvalPolicy ? (
    <TrainingProviderApprovalFields
      approvalPolicy={approvalPolicy}
      providerLabel={providerLabel}
      method={method}
      busy={busy}
      exportApproved={exportApproved}
      maximumCostUsd={maximumCostUsd}
      retentionDays={retentionDays}
      onManageProvider={
        onOpenProviderSettings
          ? () => {
              if (approvalPresentation === "dialog") {
                setProviderApprovalOpen(false);
              } else {
                onClose();
              }
              onOpenProviderSettings();
            }
          : undefined
      }
      onExportApprovedChange={setExportApproved}
      onMaximumCostChange={setMaximumCostUsd}
      onRetentionDaysChange={setRetentionDays}
    />
  ) : null;

  const content = (
    <section
      className={`training-dialog training-start-dialog${presentation === "embedded" ? " embedded" : ""}${hideMethodTabs ? " hide-method-tabs" : ""}`}
      role={presentation === "dialog" ? "dialog" : "region"}
      aria-modal={presentation === "dialog" ? "true" : undefined}
      aria-label="Start training"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {presentation === "dialog" ? (
        <div className="training-dialog-header">
          <div>
            <h2>Start training</h2>
            <p>{taskset.name}</p>
          </div>
          <button type="button" aria-label="Close start training" disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      ) : null}
      {!hideMethodTabs ? (
        <TrainingMethodTabs
          busy={busy}
          method={method}
          options={methodOptions}
          onSelect={selectMethod}
        />
      ) : null}
      <TrainingCatalogSetup
        busy={busy}
        catalog={catalog}
        catalogError={catalogError}
        selectedComputeTarget={selectedComputeTarget}
        modelSearch={modelSearch}
        onModelSearchChange={setModelSearch}
        baseModelKey={baseModelKey}
        baseModelCandidates={baseModelCandidates}
        destinationId={destinationId}
        method={method}
        onBaseModelChange={(selectionKey, selectedModelId) => {
          setBaseModelKey(selectionKey);
          setLearningRate(defaultLearningRate(selectedModelId));
        }}
        visibleCatalogModels={visibleCatalogModels}
        selectedCatalogCompatibility={selectedCatalogCompatibility}
        selectedCatalogModel={selectedCatalogModel}
        configurationContent={configurationContent}
        inlineProviderApproval={approvalPresentation === "inline" ? providerApprovalFields : null}
      />
      <TrainingStartSummary
        method={method}
        trainingExamples={trainingExamples}
        availableTrainExamples={availableTrainExamples}
        approvedExamples={approvedExamples}
        evaluationExamples={evaluationExamples}
        preparedQuote={preparedQuote}
        selectedComputeTarget={selectedComputeTarget}
        approvalPresentation={approvalPresentation}
        maximumCostUsd={maximumCostUsd}
        providerManaged={providerManaged}
        storagePath={null}
      />
      {approvalPresentation === "inline" && currentPrepared ? (
        <TrainingPreparedConfirmation
          prepared={currentPrepared}
          preparedQuote={preparedQuote}
          maximumCostUsd={maximumCostUsd}
        />
      ) : null}
      {isBootstrap && bootstrap ? (
        <div className="training-bootstrap-limitations">
          <strong>Supervised precursor</strong>
          <p>
            This SFT run teaches the approved tool trajectories. It does not replace reinforcement
            training.
          </p>
          <ul>
            {bootstrap.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <TrainingAdvancedSettings
        method={method}
        trainingExamples={trainingExamples}
        maximumTrainingExamples={maximumTrainingExamples}
        maxSteps={maxSteps}
        sequenceLength={sequenceLength}
        maximumSequenceLength={maximumSequenceLength}
        rolloutMaxOutputTokens={rolloutMaxOutputTokens}
        maximumOutputTokens={maximumOutputTokens}
        defaultRolloutOutputTokens={
          selectedComputeTarget?.defaults.rolloutOutputTokens ?? DEFAULT_ROLLOUT_OUTPUT_TOKENS
        }
        rank={rank}
        learningRate={learningRate}
        klBeta={klBeta}
        rftLossMethod={rftLossMethod}
        rolloutGroupSize={rolloutGroupSize}
        rolloutConcurrency={rolloutConcurrency}
        onTrainingExamplesChange={setTrainingExamples}
        onMaxStepsChange={setMaxSteps}
        onSequenceLengthChange={setSequenceLength}
        onRolloutMaxOutputTokensChange={setRolloutMaxOutputTokens}
        onRankChange={setRank}
        onLearningRateChange={setLearningRate}
        onKlBetaChange={setKlBeta}
        onRftLossMethodChange={setRftLossMethod}
        onRolloutGroupSizeChange={setRolloutGroupSize}
        onRolloutConcurrencyChange={setRolloutConcurrency}
      />
      {!readinessCompatible ? (
        <div className="training-banner error training-dialog-error">
          {approvalPresentation === "dialog" && approvalPolicy
            ? (configurationIncompatibility ?? "This setup is unavailable.")
            : (launchIncompatibility ?? "This setup is unavailable.")}
        </div>
      ) : destination?.nonProduction ? (
        <p className="training-start-note">
          This local worker is an experimental correctness run. It does not claim useful model
          quality.
        </p>
      ) : null}
      {hideActions ? (
        <button
          id={runControlId}
          hidden
          type="button"
          disabled={busy || !readinessCompatible}
          onClick={() => void start()}
        >
          {readinessActionLabel}
        </button>
      ) : (
        <div className="training-dialog-actions">
          <button
            className="training-button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            id={runControlId}
            className="training-button"
            type="button"
            disabled={busy || !compatible}
            onClick={() => void start()}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </section>
  );
  const providerApprovalDialog = (
    <TrainingProviderApprovalDialog
      open={approvalPresentation === "dialog" && Boolean(approvalPolicy) && providerApprovalOpen}
      busy={busy}
      destinationId={destinationId}
      baseModelId={baseModelId}
      approvalFields={providerApprovalFields}
      prepared={currentPrepared}
      preparedQuote={preparedQuote}
      compatible={compatible}
      actionLabel={actionLabel}
      onClose={() => setProviderApprovalOpen(false)}
      onConfirm={() => void performStart()}
    />
  );
  return presentation === "embedded" ? (
    <>
      {content}
      {providerApprovalDialog}
    </>
  ) : (
    <div
      className="training-dialog-backdrop"
      role="presentation"
      onMouseDown={busy ? undefined : onClose}
    >
      {content}
    </div>
  );
}
