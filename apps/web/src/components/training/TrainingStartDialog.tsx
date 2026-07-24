import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  selectPreferredRftSignalReport,
  type BaseModelCandidate,
  type BaseModelPreference,
  type BaselineReport,
  type ChatModelRef,
  type ComputeStateResponse,
  type ModelRunPreset,
  type Taskset,
  type TasksetBaselineRun,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
  type TrainingCatalog,
  type TrainingPreparedStart,
  type TrainingRecipe,
  type RftLossMethod,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { X } from "../icons";
import { trainingMethodLabel, trainingMethodName } from "./training-model-data";
import { TrainingCatalogSetup } from "./TrainingCatalogSetup";
import { TrainingProviderApprovalDialog } from "./TrainingProviderApprovalDialog";
import { TrainingProviderApprovalFields } from "./TrainingProviderApprovalFields";
import { recommendedSequenceLength } from "./training-start-defaults";
import {
  defaultRftLossMethod,
  preserveBaseModelSelection,
  trainingRecipe,
} from "./training-start-recipe";
import {
  baselineRunLabel,
  candidateForPreference,
  defaultCandidateForDestination,
  defaultLearningRate,
  destinationLabel,
  formatBytes,
  modelLabel,
  rftLossLabel,
  selectableMethods,
  tasksetMethod,
  trainingSplitCount,
} from "./training-start-view-helpers";

const DEFAULT_MAXIMUM_SEQUENCE_LENGTH = 4_096;
const DEFAULT_MAXIMUM_OUTPUT_TOKENS = 4_096;
const DEFAULT_ROLLOUT_OUTPUT_TOKENS = 64;

export type TrainingStartApproval = {
  exportApproved: boolean;
  maximumCostUsd: number | null;
  retentionDays: number | null;
  region: string | null;
};

export {
  defaultRftLossMethod,
  preserveBaseModelSelection,
  trainingRecipe,
} from "./training-start-recipe";

export function TrainingStartDialog({
  baseModelCandidates,
  connection,
  taskset,
  modelId = null,
  destinations,
  initialMethod,
  preferredBaseModel = null,
  busy,
  busyAction = null,
  onClose,
  onStart,
  onPrepare,
  onConfirmPrepared,
  onOpenProviderSettings,
  onRunBaseline,
  baselineReports = [],
  baselineRuns = [],
  presentation = "dialog",
  runControlId,
  hideActions = false,
  onReadinessChange,
  onConfigurationChange,
  runPreset = "custom",
  hideMethodTabs = false,
  approvalPresentation = "inline",
  configurationContent,
}: {
  baseModelCandidates: BaseModelCandidate[];
  connection: ClientConnection | null;
  taskset: Taskset;
  modelId?: string | null;
  destinations: TrainingDestinationCapabilities[];
  initialMethod?: "sft" | "dpo" | "grpo" | "ppo";
  preferredBaseModel?: BaseModelPreference | null;
  busy: boolean;
  busyAction?: string | null;
  onClose: () => void;
  onStart: (
    destinationId: TrainingDestinationId,
    recipe: TrainingRecipe,
    approval: TrainingStartApproval,
  ) => Promise<boolean>;
  onPrepare: (
    destinationId: TrainingDestinationId,
    recipe: TrainingRecipe,
    approval: TrainingStartApproval,
  ) => Promise<TrainingPreparedStart | null>;
  onConfirmPrepared: (
    prepared: TrainingPreparedStart,
    maximumCostUsd: number,
  ) => Promise<boolean>;
  onOpenProviderSettings?: () => void;
  onRunBaseline?: (model: ChatModelRef, options: {
    targetModelId: string | null;
    taskLimit: number;
    attemptsPerTask: number;
    selectionSeed: number;
    split: "train" | "frozen_eval";
    selectionStrategy: "stable_hash_top_n" | "rft_easy_curriculum_v1";
    sampling: {
      maxOutputTokens: number;
      temperature: number;
      topP: number;
    };
  }) => Promise<boolean>;
  baselineReports?: BaselineReport[];
  baselineRuns?: TasksetBaselineRun[];
  presentation?: "dialog" | "embedded";
  runControlId?: string;
  hideActions?: boolean;
  onReadinessChange?: (state: {
    ready: boolean;
    reason: string | null;
    actionLabel: string;
  }) => void;
  onConfigurationChange?: (configuration: {
    baseModel: BaseModelPreference | null;
    method: "sft" | "dpo" | "grpo" | "ppo";
    destinationId: TrainingDestinationId;
    recipe: TrainingRecipe;
    approval: TrainingStartApproval;
  }) => void;
  runPreset?: ModelRunPreset;
  hideMethodTabs?: boolean;
  approvalPresentation?: "inline" | "dialog";
  configurationContent?: ReactNode;
}) {
  const trainingPath = taskset.readiness?.trainingPath ?? null;
  const primaryMethod = trainingPath?.primaryMethod ?? tasksetMethod(taskset);
  const bootstrap = trainingPath?.bootstrap ?? null;
  const methodOptions = selectableMethods(taskset);
  const requestedInitialMethod = initialMethod && methodOptions.includes(initialMethod)
    ? initialMethod
    : primaryMethod === "grpo" ? "grpo"
      : primaryMethod === "dpo" ? "dpo"
        : primaryMethod === "ppo" ? "ppo"
        : "sft";
  const quickTest =
    runPreset === "small" || runPreset === "small_experiment";
  const preferredCandidate = candidateForPreference(
    baseModelCandidates,
    preferredBaseModel,
  );
  const preferredOption = preferredCandidate?.executionOptions.find((option) =>
    option.available && option.methods.includes(requestedInitialMethod)) ?? null;
  const initialDestination = preferredOption?.destinationId
    ?? destinations.find((destination) => destination.destinationId === "local_cpu_fixture" && destination.available)?.destinationId
    ?? destinations.find((destination) => destination.available && destination.destinationId !== "export")?.destinationId
    ?? "local_cpu_fixture";
  const [destinationId, setDestinationId] = useState<TrainingDestinationId>(initialDestination);
  const [compute, setCompute] = useState<ComputeStateResponse | null>(null);
  const [catalog, setCatalog] = useState<TrainingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [computeTargetId, setComputeTargetId] = useState<string>(
    initialDestination,
  );
  const [modelSearch, setModelSearch] = useState("");
  const initialCandidate = preferredOption
    ? preferredCandidate
    : defaultCandidateForDestination(
      baseModelCandidates,
      initialDestination,
      requestedInitialMethod,
    );
  const [baseModelKey, setBaseModelKey] = useState(
    initialCandidate?.selectionKey ?? "",
  );
  const [deviceId, setDeviceId] = useState("automatic");
  const [maxSteps, setMaxSteps] = useState(() =>
    quickTest && requestedInitialMethod !== "grpo"
      ? 1
      : requestedInitialMethod === "grpo"
      ? runPreset === "standard" ? 50 : 8
      : requestedInitialMethod === "dpo"
        ? runPreset === "standard" ? 100 : 4
        : requestedInitialMethod === "ppo"
          ? runPreset === "standard" ? 20 : 2
        : runPreset === "standard" ? 100 : 2);
  const availableTrainExamples = trainingSplitCount(taskset, "train");
  const [trainingExamples, setTrainingExamples] = useState(() =>
    Math.max(
      1,
      Math.min(
        availableTrainExamples,
        requestedInitialMethod === "dpo"
          ? quickTest
            ? 2
            : taskset.learningSignals.preferences.filter((pair) => pair.approved).length
          : requestedInitialMethod === "ppo"
            ? quickTest ? 2 : runPreset === "standard" ? 16 : 4
          : requestedInitialMethod === "grpo" && taskset.datasetArtifact
          ? runPreset === "standard" ? 32 : 16
          : quickTest ? 4 : 1_000,
      ),
    ));
  const [sequenceLength, setSequenceLength] = useState(() => {
    return recommendedSequenceLength(taskset);
  });
  const [rank, setRank] = useState(2);
  const [learningRate, setLearningRate] = useState(() =>
    defaultLearningRate(initialCandidate?.preference.modelId ?? ""));
  const [exportApproved, setExportApproved] = useState(false);
  const [maximumCostUsd, setMaximumCostUsd] = useState<number | null>(null);
  const [retentionDays, setRetentionDays] = useState(7);
  const [rolloutGroupSize, setRolloutGroupSize] = useState(8);
  const [rolloutConcurrency, setRolloutConcurrency] = useState(4);
  const [rolloutMaxOutputTokens, setRolloutMaxOutputTokens] = useState(
    DEFAULT_ROLLOUT_OUTPUT_TOKENS,
  );
  const [rftLossMethod, setRftLossMethod] = useState<RftLossMethod>(() =>
    defaultRftLossMethod(taskset));
  const [method, setMethod] = useState<"sft" | "dpo" | "grpo" | "ppo">(requestedInitialMethod);
  const [prepared, setPrepared] = useState<{
    configurationKey: string;
    value: TrainingPreparedStart;
  } | null>(null);
  const [providerApprovalOpen, setProviderApprovalOpen] = useState(false);
  const destination = destinations.find((item) => item.destinationId === destinationId) ?? null;
  const isBootstrap = method === "sft" && primaryMethod !== "sft" && bootstrap?.method === "sft";
  const approvedExamples = method === "dpo"
    ? taskset.learningSignals.preferences.filter((pair) => pair.approved).length
    : taskset.learningSignals.demonstrations.filter((example) => example.approved).length;
  const evaluationExamples = trainingSplitCount(taskset, "frozen_eval");
  const selectableDevices = useMemo(() => compute?.inventory?.devices.filter((device) => device.available) ?? [], [compute?.inventory?.devices]);
  const trainableModels = useMemo(() => compute?.inventory?.models.filter((model) => model.trainingCompatible && model.modelId && model.revision && model.tokenizerRevision && model.chatTemplateHash) ?? [], [compute?.inventory?.models]);
  const selectedBaseModel = baseModelCandidates.find((candidate) =>
    candidate.selectionKey === baseModelKey) ?? null;
  const selectedExecutionOption = selectedBaseModel?.executionOptions.find((option) =>
    option.destinationId === destinationId && option.methods.includes(method)) ?? null;
  const baseModelId = selectedBaseModel?.preference.modelId ?? "";
  const selectedModel = selectedBaseModel?.preference.modelAssetId
    ? trainableModels.find((model) =>
        model.id === selectedBaseModel.preference.modelAssetId) ?? null
    : trainableModels.find((model) => model.modelId === baseModelId) ?? null;
  const catalogTargets = useMemo<TrainingCatalog["targets"]>(
    () =>
      catalog?.targets ??
      destinations.map((destination) => ({
        id: destination.destinationId,
        label: destinationLabel(destination.destinationId),
        description:
          destination.unavailableReason ??
          "Server-reported training destination.",
        destinationId: destination.destinationId,
        computeAdapterId: destination.destinationId,
        runtimeAdapterId: "resolving",
        engineAdapterId: "resolving",
        methods: destination.methods,
        capabilityPills: [destinationLabel(destination.destinationId)],
        executionMode: "local_worker" as const,
        approvalPolicy: null,
        limits: {
          maximumSequenceLength: DEFAULT_MAXIMUM_SEQUENCE_LENGTH,
          maximumOutputTokens: DEFAULT_MAXIMUM_OUTPUT_TOKENS,
          maximumTrainingExamples: null,
        },
        defaults: {
          loraRank: 2,
          rolloutOutputTokens: DEFAULT_ROLLOUT_OUTPUT_TOKENS,
        },
        available: destination.available,
        unavailableReason: destination.unavailableReason,
      })),
    [catalog?.targets, destinations],
  );
  const selectedComputeTarget = catalogTargets.find(
    (target) => target.id === computeTargetId,
  ) ?? null;
  const selectedCatalogModel = catalog?.models.find(
    (model) => model.selectionKey === baseModelKey,
  ) ?? null;
  const selectedCatalogCompatibility =
    selectedCatalogModel?.compatibilities.find(
      (compatibility) =>
        compatibility.targetId === selectedComputeTarget?.id &&
        compatibility.methods.includes(method),
    ) ?? null;
  const visibleCatalogModels = useMemo(() => {
    const models = catalog?.models ?? [];
    const query = modelSearch.trim().toLowerCase();
    if (!query) {
      return models.filter((model) => model.source !== "search");
    }
    return models.filter((model) =>
      `${model.label} ${model.modelId} ${model.source}`
        .toLowerCase()
        .includes(query),
    );
  }, [catalog?.models, modelSearch]);
  const approvalPolicy = selectedComputeTarget?.approvalPolicy ?? null;
  const providerManaged = selectedComputeTarget?.executionMode === "provider_native";
  const providerLabel = approvalPolicy?.providerLabel ?? "provider";
  const maximumSequenceLength =
    selectedComputeTarget?.limits.maximumSequenceLength ??
    DEFAULT_MAXIMUM_SEQUENCE_LENGTH;
  const maximumOutputTokens =
    selectedComputeTarget?.limits.maximumOutputTokens ??
    DEFAULT_MAXIMUM_OUTPUT_TOKENS;
  const rftSelectionStrategy = taskset.datasetArtifact
    ? "rft_easy_curriculum_v1" as const
    : "stable_hash_top_n" as const;
  const rftSampling = {
    maxOutputTokens: rolloutMaxOutputTokens,
    temperature: 0.8,
    topP: 0.95,
  };
  const alignedTrainBaseline = selectPreferredRftSignalReport(
    baselineReports,
    {
      split: "train",
      taskCount: trainingExamples,
      attemptsPerTask: rolloutGroupSize,
      selectionSeed: 17,
      selectionStrategy: rftSelectionStrategy,
      model: {
        providerId: approvalPolicy?.providerId ?? "openpond",
        modelId: baseModelId,
      },
      sampling: rftSampling,
    },
  );
  const alignedBaselineRun = baselineRuns.find((run) =>
    run.tasksetHash === taskset.contentHash
    && run.configuration.split === "train"
    && run.configuration.taskLimit === trainingExamples
    && run.configuration.attemptsPerTask === rolloutGroupSize
    && run.configuration.selectionSeed === 17
    && run.configuration.selectionStrategy === rftSelectionStrategy
    && run.configuration.model.providerId ===
      (approvalPolicy?.providerId ?? "openpond")
    && run.configuration.model.modelId === baseModelId
    && run.configuration.sampling.maxOutputTokens === rftSampling.maxOutputTokens
    && run.configuration.sampling.temperature === rftSampling.temperature
    && run.configuration.sampling.topP === rftSampling.topP) ?? null;
  const baselineRunActive = alignedBaselineRun
    ? ["queued", "preparing", "running", "cancelling"].includes(alignedBaselineRun.status)
    : false;
  const baselineRunFailed = alignedBaselineRun?.status === "failed";
  const baselineBusy = busyAction === "baseline" || baselineRunActive;
  const baselineReport = taskset.datasetArtifact
    ? alignedTrainBaseline
    : baselineReports.find((report) =>
        report.id === taskset.readiness?.baselineReportId) ?? null;
  const baselineReward = taskset.readiness?.baselineReward ?? null;
  const rftBaselineReady = method !== "grpo" || (taskset.datasetArtifact
    ? alignedTrainBaseline?.rftSignal?.passed === true
    : Boolean(
        taskset.readiness?.baselineReportId
        && baselineReward
        && baselineReward.count >= 2
        && (baselineReward.variance ?? 0) > 0
        && (baselineReward.mean ?? 0) > 0.05
        && (baselineReward.mean ?? 0) < 0.95
      ));
  const baselineInfrastructureFailures = baselineReport
    ? Object.entries(baselineReport.failureClusters)
        .filter(([key]) => key === "infrastructure_failure")
        .reduce((total, [, count]) => total + count, 0)
    : 0;
  const baselineAttemptCount = baselineReport?.attemptRefs.length ?? 0;
  const baselineFailed = Boolean(
    baselineReport
    && baselineReport.reward.count === 0
    && baselineInfrastructureFailures > 0
  );
  const baselineSignalInsufficient = Boolean(
    baselineReport?.rftSignal
    && !baselineReport.rftSignal.passed
    && !baselineFailed
  );
  const maximumTrainingExamples = method === "dpo"
    ? Math.max(1, taskset.learningSignals.preferences.filter((pair) => pair.approved).length)
    : method === "ppo"
      ? Math.max(1, Math.min(1_000, availableTrainExamples))
    : method === "grpo"
    && providerManaged
    && taskset.datasetArtifact
    ? Math.max(
        1,
        Math.min(
          selectedComputeTarget?.limits.maximumTrainingExamples ??
            availableTrainExamples,
          availableTrainExamples,
        ),
      )
    : Math.max(1, Math.min(100_000, availableTrainExamples));
  const approvalReady = !approvalPolicy || (
    (!approvalPolicy.exportApprovalRequired || exportApproved) &&
    maximumCostUsd != null &&
    maximumCostUsd >= approvalPolicy.minimumSpendUsd &&
    maximumCostUsd <= approvalPolicy.maximumSpendUsd &&
    Number.isInteger(retentionDays) &&
    retentionDays >= approvalPolicy.minimumRetentionDays &&
    retentionDays <= approvalPolicy.maximumRetentionDays
  );
  const executableMethod =
    selectedComputeTarget?.methods.includes(method) ??
    destination?.methods.includes(method as never) ??
    false;
  const tasksetMethodCompatible = taskset.capabilities.compatibleMethods.includes(method as never)
    || bootstrap?.method === method;
  const configurationCompatible = Boolean(
    taskset.readiness?.ready &&
    executableMethod &&
    destination?.available &&
    destination.methods.includes(method as never) &&
    tasksetMethodCompatible &&
    selectedExecutionOption?.available &&
    selectedCatalogCompatibility?.state !== "unsupported" &&
    selectedCatalogCompatibility?.state !== "compute_setup_required" &&
    (selectedBaseModel?.preference.source !== "local" || Boolean(selectedModel)),
  );
  const compatible = configurationCompatible && rftBaselineReady && approvalReady;
  const configurationIncompatibility = !taskset.readiness?.ready
    ? "The Taskset must pass environment, grader, and data readiness before training."
    : !executableMethod
      ? `${method.toUpperCase()} is the primary recommendation but no compatible execution backend is available here.${bootstrap ? " Choose the optional SFT trajectory bootstrap to run the local precursor." : ""}`
      : selectedCatalogCompatibility?.state === "unsupported" ||
        selectedCatalogCompatibility?.state === "compute_setup_required"
        ? selectedCatalogCompatibility.reason ??
          "The selected Model and compute target are not ready."
      : !selectedBaseModel
        ? `Choose starting weights compatible with ${destinationLabel(destinationId)} and ${method.toUpperCase()}.`
        : !selectedExecutionOption?.available
          ? selectedExecutionOption?.unavailableReason ?? "The selected base model cannot run on this compute destination."
          : selectedBaseModel.preference.source === "local" && !selectedModel
            ? "The selected local model is no longer present in the verified compute inventory. Scan Compute and select it again."
      : !destination?.methods.includes(method as never)
        ? `${destinationLabel(destinationId)} does not execute ${method.toUpperCase()}.`
      : destination?.unavailableReason ?? null;
  const launchIncompatibility = configurationIncompatibility
    ?? (!rftBaselineReady
      ? "Verify mixed rewards on the selected train prompts before preparing a paid training quote."
      : approvalPolicy?.exportApprovalRequired && !exportApproved
        ? `Approve the bounded train-split export before launching ${providerLabel}.`
        : approvalPolicy && (
            maximumCostUsd == null ||
            maximumCostUsd < approvalPolicy.minimumSpendUsd ||
            maximumCostUsd > approvalPolicy.maximumSpendUsd
          )
          ? `Set a ${providerLabel} cap from $${approvalPolicy.minimumSpendUsd.toFixed(2)} through $${approvalPolicy.maximumSpendUsd.toFixed(2)}.`
          : approvalPolicy && (
              !Number.isInteger(retentionDays) ||
              retentionDays < approvalPolicy.minimumRetentionDays ||
              retentionDays > approvalPolicy.maximumRetentionDays
            )
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
    model: selectedModel,
    rolloutGroupSize,
    rolloutConcurrency,
    rolloutMaxOutputTokens,
    trainingExamples,
    rftLossMethod,
    executionMode: selectedComputeTarget?.executionMode,
    catalogModel: selectedCatalogModel,
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
  const currentPrepared = prepared?.configurationKey === configurationKey
    ? prepared.value
    : null;

  useEffect(() => {
    if (!connection) return;
    let active = true;
    void Promise.all([
      api.computeState(connection),
      api.portableTrainingCatalog(connection),
    ]).then(([state, nextCatalog]) => {
      if (!active) return;
      setCompute(state);
      setCatalog(nextCatalog);
      setCatalogError(null);
      setDeviceId(state.settings.defaultDeviceIds[0] ?? "automatic");
      setComputeTargetId((current) =>
        nextCatalog.targets.find((target) => target.id === current)?.id ??
        nextCatalog.targets.find(
          (target) => target.destinationId === initialDestination,
        )?.id ??
        nextCatalog.targets[0]?.id ??
        "",
      );
    }).catch((error: unknown) => {
      if (!active) return;
      setCatalogError(
        error instanceof Error
          ? error.message
          : "The training catalog could not be loaded.",
      );
    });
    return () => { active = false; };
  }, [connection, initialDestination]);

  useEffect(() => {
    if (!connection) return;
    let active = true;
    const query = modelSearch.trim().length >= 2 ? modelSearch.trim() : "";
    const timeout = window.setTimeout(() => {
      void api.portableTrainingCatalog(connection, query)
        .then((nextCatalog) => {
          if (!active) return;
          setCatalog(nextCatalog);
          setCatalogError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setCatalogError(
            error instanceof Error
              ? error.message
              : "The Model registry search could not be completed.",
          );
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [connection, modelSearch]);

  async function performStart() {
    if (!compatible) return;
    if (approvalPolicy?.preparationRequired && !currentPrepared) {
      const next = await onPrepare(destinationId, recipe, approval);
      if (next) setPrepared({ configurationKey, value: next });
      return;
    }
    const completed = approvalPolicy?.preparationRequired && currentPrepared
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
    target = catalogTargets.find(
      (candidate) => candidate.destinationId === next,
    ),
  ) {
    setDestinationId(next);
    setBaseModelKey((current) => preserveBaseModelSelection(
      baseModelCandidates,
      current,
      next,
      method,
    ));
    setRank(target?.defaults.loraRank ?? 2);
    setRolloutMaxOutputTokens(
      target?.defaults.rolloutOutputTokens ?? DEFAULT_ROLLOUT_OUTPUT_TOKENS,
    );
    setMaximumCostUsd(
      target?.approvalPolicy?.defaultMaximumSpendUsd ?? null,
    );
    setRetentionDays(target?.approvalPolicy?.defaultRetentionDays ?? 7);
    setExportApproved(false);
    if (method === "grpo") {
      setMaxSteps(8);
      if (taskset.datasetArtifact && target?.executionMode === "provider_native") {
        setTrainingExamples(
          Math.max(
            1,
            Math.min(
              availableTrainExamples,
              target.limits.maximumTrainingExamples ?? 16,
            ),
          ),
        );
      }
      setSequenceLength(Math.min(
        target?.limits.maximumSequenceLength ?? DEFAULT_MAXIMUM_SEQUENCE_LENGTH,
        Math.max(
        512,
          recommendedSequenceLength(
            taskset,
            target?.limits.maximumSequenceLength,
          ),
        ),
      ));
    } else {
      setSequenceLength(
        recommendedSequenceLength(
          taskset,
          target?.limits.maximumSequenceLength,
        ),
      );
    }
  }

  function selectComputeTarget(next: string) {
    const target = catalogTargets.find((candidate) => candidate.id === next);
    if (!target) return;
    setComputeTargetId(target.id);
    selectDestination(target.destinationId as TrainingDestinationId, target);
  }

  function selectMethod(next: "sft" | "dpo" | "grpo" | "ppo") {
    setMethod(next);
    setPrepared(null);
    setBaseModelKey((current) => preserveBaseModelSelection(
      baseModelCandidates,
      current,
      destinationId,
      next,
    ));
    if (next === "grpo") {
      setMaxSteps(8);
      if (providerManaged && taskset.datasetArtifact) {
        setSequenceLength((current) => Math.max(512, current));
      }
      setTrainingExamples(Math.max(
        1,
        Math.min(
          availableTrainExamples,
          taskset.datasetArtifact ? 16 : 1_000,
        ),
      ));
      return;
    }
    setMaxSteps(
      quickTest ? 1 : next === "dpo" ? 4 : next === "ppo" ? 2 : 2,
    );
    if (next === "dpo") {
      setTrainingExamples(Math.max(
        1,
        Math.min(
          taskset.learningSignals.preferences.filter((pair) => pair.approved).length,
          quickTest ? 2 : 64,
        ),
      ));
      return;
    }
    if (next === "ppo") {
      setTrainingExamples(
        Math.max(1, Math.min(availableTrainExamples, quickTest ? 2 : 4)),
      );
      return;
    }
    setTrainingExamples(
      Math.max(1, Math.min(availableTrainExamples, quickTest ? 4 : 32)),
    );
  }
  const preparedQuote = currentPrepared?.plan.estimatedCostUsd ?? null;
  const actionLabel = busy
    ? busyAction === "baseline"
      ? "Base-model test running"
      : currentPrepared
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
    approvalPresentation === "dialog" && approvalPolicy
      ? configurationCompatible
      : compatible;
  const readinessActionLabel =
    approvalPresentation === "dialog" && approvalPolicy ? "Run" : actionLabel;

  useEffect(() => {
    onReadinessChange?.({
      ready: readinessCompatible,
      reason: readinessCompatible
        ? null
        : approvalPresentation === "dialog" && approvalPolicy
          ? configurationIncompatibility ?? "This setup is unavailable."
          : launchIncompatibility ?? "This setup is unavailable.",
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
  }, [
    configurationKey,
    onConfigurationChange,
  ]);

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

  const content = <section className={`training-dialog training-start-dialog${presentation === "embedded" ? " embedded" : ""}${hideMethodTabs ? " hide-method-tabs" : ""}`} role={presentation === "dialog" ? "dialog" : "region"} aria-modal={presentation === "dialog" ? "true" : undefined} aria-label="Start training" onMouseDown={(event) => event.stopPropagation()}>
      {presentation === "dialog" ? <div className="training-dialog-header"><div><h2>Start training</h2><p>{taskset.name}</p></div><button type="button" aria-label="Close start training" disabled={busy} onClick={onClose}><X size={16}/></button></div> : null}
      {!hideMethodTabs ? <div className="training-method-tabs" role="tablist" aria-label="Training method">
        {methodOptions.map((candidate) => (
          <button
            aria-selected={candidate === method}
            className={candidate === method ? "active" : ""}
            disabled={busy}
            key={candidate}
            role="tab"
            type="button"
            onClick={() => selectMethod(candidate)}
          >
            <span>{trainingMethodName(candidate)}</span>
            <strong>{trainingMethodLabel(candidate)}</strong>
          </button>
        ))}
      </div> : null}
      <TrainingCatalogSetup
        busy={busy}
        catalog={catalog}
        catalogError={catalogError}
        catalogTargets={catalogTargets}
        selectedComputeTarget={selectedComputeTarget}
        computeTargetId={computeTargetId}
        onComputeTargetChange={selectComputeTarget}
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
        deviceId={deviceId}
        selectableDevices={selectableDevices}
        onDeviceChange={setDeviceId}
        selectedCatalogCompatibility={selectedCatalogCompatibility}
        selectedCatalogModel={selectedCatalogModel}
        configurationContent={configurationContent}
        inlineProviderApproval={
          approvalPresentation === "inline"
            ? providerApprovalFields
            : null
        }
      />
      <dl className="training-start-summary">
        <div><dt>Training data</dt><dd>{method === "grpo" || method === "ppo" ? `${Math.min(trainingExamples, availableTrainExamples)} of ${availableTrainExamples} approved train prompts` : method === "dpo" ? `${Math.min(trainingExamples, approvedExamples)} of ${approvedExamples} approved preference pairs` : `${Math.min(trainingExamples, approvedExamples || availableTrainExamples)} approved example${trainingExamples === 1 ? "" : "s"}`}</dd></div>
        <div><dt>Evaluation</dt><dd>{evaluationExamples} test example{evaluationExamples === 1 ? "" : "s"}</dd></div>
        <div><dt>{preparedQuote == null ? "Estimate" : "Exact quote"}</dt><dd>{selectedComputeTarget?.computeAdapterId === "local-cpu" ? selectedModel ? `$0 · ${maxSteps} steps × ${sequenceLength} tokens · 15-minute hard stop` : "$0 · 2-minute hard stop" : approvalPolicy ? approvalPresentation === "dialog" ? "Reviewed when you Run" : preparedQuote == null ? `Prepare a provider-validated quote · hard cap $${maximumCostUsd != null && Number.isFinite(maximumCostUsd) ? maximumCostUsd.toFixed(2) : "—"}` : `$${preparedQuote.toFixed(2)} · hard cap $${(maximumCostUsd ?? 0).toFixed(2)}` : "Provided before approval"}</dd></div>
        <div><dt>Storage</dt><dd>{providerManaged ? "Portable output imported into app-managed storage" : compute?.settings.modelStorePath ?? "App-managed storage"}</dd></div>
      </dl>
      {approvalPresentation === "inline" && currentPrepared ? (
        <section className="training-prepared-confirmation" aria-label="Confirm paid training launch">
          <div>
            <strong>Ready to launch</strong>
            <span>The quote and prepared data are fixed to this confirmation.</span>
          </div>
          <dl className="training-start-summary">
            <div><dt>Account</dt><dd>{currentPrepared.approvalActor ?? "Local user"}</dd></div>
            <div><dt>Provider</dt><dd>{destinationLabel(currentPrepared.plan.destinationId)}</dd></div>
            <div><dt>Model</dt><dd>{modelLabel(currentPrepared.plan.recipe.method === "dpo" ? currentPrepared.plan.recipe.policyModel.id : currentPrepared.plan.recipe.method === "ppo" ? currentPrepared.plan.recipe.policyOptimization.policyModel.id : currentPrepared.plan.recipe.method === "sft" || currentPrepared.plan.recipe.method === "grpo" ? currentPrepared.plan.recipe.baseModel.id : "")}</dd></div>
            <div><dt>Method</dt><dd>{currentPrepared.plan.recipe.method === "grpo" ? `RFT · ${rftLossLabel(currentPrepared.plan.recipe.loss.method)}` : `${trainingMethodLabel(currentPrepared.plan.recipe.method)} · ${currentPrepared.plan.recipe.parameterization.toUpperCase()}`}</dd></div>
            <div><dt>Quote</dt><dd>{preparedQuote == null ? "Unavailable" : `$${preparedQuote.toFixed(2)}`}</dd></div>
            <div><dt>Maximum</dt><dd>{maximumCostUsd == null ? "Unavailable" : `$${maximumCostUsd.toFixed(2)}`}</dd></div>
            <div><dt>Retention</dt><dd>{currentPrepared.plan.dataPolicy.retentionDays} days</dd></div>
            <div><dt>Prepared data</dt><dd>{formatBytes(currentPrepared.bundle.totalSizeBytes)} · verified</dd></div>
            {currentPrepared.plan.rftSignalGate ? <div><dt>Train signal</dt><dd>{currentPrepared.plan.rftSignalGate.signal.mixedRewardGroups} mixed groups · verified</dd></div> : null}
          </dl>
          <p>No provider dataset or job exists until you launch.</p>
        </section>
      ) : null}
      {approvalPresentation === "inline" && method === "grpo" && providerManaged ? (
        <section className="training-prepared-confirmation" aria-label={taskset.datasetArtifact ? "Train-signal check" : "Base-model test"}>
          <div>
            <strong>{taskset.datasetArtifact
                ? rftBaselineReady
                  ? "Train signal verified"
                : baselineFailed || baselineRunFailed
                  ? "Train-signal check failed"
                  : baselineReport?.rftSignal?.parseableAttempts === 0
                    ? "No final answers returned"
                  : baselineSignalInsufficient
                    ? "Not enough train signal"
                    : "Check train signal"
              : rftBaselineReady
                ? "Base-model test complete"
                : baselineFailed
                  ? "Base-model test failed"
                  : "Test the base model"}</strong>
            <span>{taskset.datasetArtifact
              ? rftBaselineReady && baselineReport
                ? `${baselineReport.rftSignal?.mixedRewardGroups ?? 0} of ${baselineReport.scope?.taskCount ?? trainingExamples} prompts produced both correct and incorrect rewards · ${baselineReport.rftSignal?.correctAttempts ?? 0} of ${baselineReport.rftSignal?.eligibleAttempts ?? 0} answers correct · $${(baselineReport.totalCostUsd ?? 0).toFixed(2)} recorded cost.`
                : baselineRunFailed
                  ? `${alignedBaselineRun?.error ?? "The train-signal check failed before it completed."} No training job was started.`
                : baselineFailed
                  ? `${baselineInfrastructureFailures} of ${baselineAttemptCount} attempts failed before grading. No training job was started.`
                  : baselineReport?.rftSignal?.parseableAttempts === 0
                    ? `All ${baselineReport.rftSignal.eligibleAttempts} requests completed, but none returned a parseable final answer. No training job was started.`
                  : baselineSignalInsufficient
                    ? `${baselineReport?.rftSignal?.mixedRewardGroups ?? 0} of ${trainingExamples} prompts produced mixed rewards; ${baselineReport?.rftSignal?.requiredMixedRewardGroups ?? 4} are required. No training job was started.`
                    : `Run ${trainingExamples} selected train prompts with ${rolloutGroupSize} candidates each. At least 4 prompts must produce both correct and incorrect rewards before training can launch.`
              : rftBaselineReady && baselineReport
                ? `${baselineReport.reward.count} graded attempts · ${(100 * (baselineReport.reward.mean ?? 0)).toFixed(0)}% correct · $${(baselineReport.totalCostUsd ?? 0).toFixed(2)} recorded cost.`
                : baselineFailed
                  ? `${baselineInfrastructureFailures} of ${baselineAttemptCount} attempts failed before grading. No training job was started.`
                  : "Run 8 held-back prompts with 4 attempts each before training. Answers and grading stay inside OpenPond."}</span>
            {!rftBaselineReady ? <span>{taskset.datasetArtifact ? "The check" : "The test"} may start temporary provider inference capacity and removes it when finished. Its exact cap is reviewed separately.</span> : null}
          </div>
          {!rftBaselineReady ? <button
              className="training-button secondary"
              type="button"
              disabled={baselineBusy || !baseModelId || !onRunBaseline}
              onClick={() => {
                if (!onRunBaseline || !baseModelId) return;
                void onRunBaseline(
                  {
                    providerId: approvalPolicy?.providerId ?? "openpond",
                    modelId: baseModelId,
                  },
                  {
                    targetModelId: modelId,
                    taskLimit: taskset.datasetArtifact ? trainingExamples : 8,
                    attemptsPerTask: taskset.datasetArtifact ? rolloutGroupSize : 4,
                    selectionSeed: 17,
                    split: taskset.datasetArtifact ? "train" : "frozen_eval",
                    selectionStrategy: rftSelectionStrategy,
                    sampling: rftSampling,
                  },
                );
              }}
            >
              {taskset.datasetArtifact
                ? baselineBusy ? baselineRunLabel(alignedBaselineRun) : baselineReport || baselineRunFailed ? "Retry train-signal check" : "Run train-signal check"
                : baselineBusy ? "Testing base model…" : baselineFailed ? "Retry base-model test" : "Test base model"}
            </button> : null}
        </section>
      ) : null}
      {isBootstrap && bootstrap ? <div className="training-bootstrap-limitations"><strong>Supervised precursor</strong><p>This SFT run teaches the approved tool trajectories. It does not replace reinforcement training.</p><ul>{bootstrap.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div> : null}
      <details className="training-start-advanced"><summary>Advanced settings</summary><div className="training-start-fields"><label><span>Training examples</span><input type="number" min={1} max={maximumTrainingExamples} value={trainingExamples} onChange={(event) => setTrainingExamples(Math.max(1, Math.min(maximumTrainingExamples, event.target.valueAsNumber || 1)))}/></label><label><span>Optimizer steps</span><input type="number" min={1} max={1000} value={maxSteps} onChange={(event) => setMaxSteps(event.target.valueAsNumber || 1)}/></label><label><span>{method === "grpo" ? "Prompt length" : "Sequence length"}</span><input type="number" min={16} max={maximumSequenceLength} value={sequenceLength} onChange={(event) => setSequenceLength(event.target.valueAsNumber || 64)}/></label>{method === "grpo" ? <label><span>Maximum output</span><input type="number" min={16} max={maximumOutputTokens} value={rolloutMaxOutputTokens} onChange={(event) => setRolloutMaxOutputTokens(Math.max(16, Math.min(maximumOutputTokens, event.target.valueAsNumber || selectedComputeTarget?.defaults.rolloutOutputTokens || DEFAULT_ROLLOUT_OUTPUT_TOKENS)))}/></label> : null}<label><span>LoRA rank</span><input type="number" min={1} max={256} value={rank} onChange={(event) => setRank(event.target.valueAsNumber || 2)}/></label><label><span>Learning rate</span><input type="number" min={0.000001} max={0.1} step={0.0001} value={learningRate} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setLearningRate(value); }}/></label>{method === "grpo" ? <><label><span>RL loss</span><select aria-label="RL loss" value={rftLossMethod} onChange={(event) => setRftLossMethod(event.target.value as RftLossMethod)}><option value="dapo">DAPO</option><option value="grpo">GRPO</option><option value="gspo-token">GSPO-token</option></select></label><label><span>Rollouts per prompt</span><input type="number" min={2} max={16} value={rolloutGroupSize} onChange={(event) => setRolloutGroupSize(event.target.valueAsNumber || 8)}/></label><label><span>Concurrent rollouts</span><input type="number" min={1} max={16} value={rolloutConcurrency} onChange={(event) => setRolloutConcurrency(event.target.valueAsNumber || 4)}/></label></> : null}</div></details>
      {!readinessCompatible ? <div className="training-banner error training-dialog-error">{approvalPresentation === "dialog" && approvalPolicy ? configurationIncompatibility ?? "This setup is unavailable." : launchIncompatibility ?? "This setup is unavailable."}</div> : destination?.nonProduction ? <p className="training-start-note">This local worker is an experimental correctness run. It does not claim useful model quality.</p> : null}
      {hideActions ? <button id={runControlId} hidden type="button" disabled={busy || !readinessCompatible} onClick={() => void start()}>{readinessActionLabel}</button> : <div className="training-dialog-actions"><button className="training-button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button id={runControlId} className="training-button" type="button" disabled={busy || !compatible} onClick={() => void start()}>{actionLabel}</button></div>}
    </section>;
  const providerApprovalDialog = (
    <TrainingProviderApprovalDialog
      open={
        approvalPresentation === "dialog" &&
        Boolean(approvalPolicy) &&
        providerApprovalOpen
      }
      busy={busy}
      destinationId={destinationId}
      baseModelId={baseModelId}
      method={method}
      rftBaselineReady={rftBaselineReady}
      baselineBusy={baselineBusy}
      baselineActionLabel={
        baselineBusy
          ? baselineRunLabel(alignedBaselineRun)
          : baselineRunFailed || baselineFailed
            ? "Retry train-signal check"
            : "Run train-signal check"
      }
      baselineActionAvailable={Boolean(onRunBaseline)}
      onRunBaseline={() => {
        if (!onRunBaseline || !baseModelId || !approvalPolicy) return;
        void onRunBaseline(
          {
            providerId: approvalPolicy.providerId,
            modelId: baseModelId,
          },
          {
            targetModelId: modelId,
            taskLimit: taskset.datasetArtifact ? trainingExamples : 8,
            attemptsPerTask: taskset.datasetArtifact ? rolloutGroupSize : 4,
            selectionSeed: 17,
            split: taskset.datasetArtifact ? "train" : "frozen_eval",
            selectionStrategy: rftSelectionStrategy,
            sampling: rftSampling,
          },
        );
      }}
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
