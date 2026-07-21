import { useEffect, useMemo, useState } from "react";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
  DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
  DATASET_NO_TOOLS_CONTRACT_HASH,
  selectPreferredRftSignalReport,
  type BaseModelCandidate,
  type BaseModelPreference,
  type BaselineReport,
  type ChatModelRef,
  type ComputeStateResponse,
  type ModelAsset,
  type Taskset,
  type TasksetBaselineRun,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
  type TrainingPreparedStart,
  type TrainingRecipe,
  type RftLossMethod,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { X } from "../icons";
import { trainingMethodLabel, trainingMethodName } from "./training-model-data";
import { recommendedSequenceLength } from "./training-start-defaults";

const SMOLLM2_LORA_TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"];
const FIREWORKS_DEFAULT_MODEL = "accounts/fireworks/models/qwen3-8b";
const FIREWORKS_CONSERVATIVE_ESTIMATE_USD = 3;
const FIREWORKS_MAXIMUM_CAP_USD = 9.99;
const FIREWORKS_MAXIMUM_SEQUENCE_LENGTH = 32_768;
const FIREWORKS_DEFAULT_RFT_MAX_OUTPUT_TOKENS = 2_048;
const FIREWORKS_MAXIMUM_RFT_OUTPUT_TOKENS = 8_192;

export type TrainingStartApproval = {
  exportApproved: boolean;
  maximumCostUsd: number | null;
  retentionDays: number | null;
  region: string | null;
};

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
}: {
  baseModelCandidates: BaseModelCandidate[];
  connection: ClientConnection | null;
  taskset: Taskset;
  modelId?: string | null;
  destinations: TrainingDestinationCapabilities[];
  initialMethod?: "sft" | "grpo";
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
}) {
  const trainingPath = taskset.readiness?.trainingPath ?? null;
  const primaryMethod = trainingPath?.primaryMethod ?? tasksetMethod(taskset);
  const bootstrap = trainingPath?.bootstrap ?? null;
  const methodOptions = selectableMethods(taskset);
  const requestedInitialMethod = initialMethod && methodOptions.includes(initialMethod)
    ? initialMethod
    : primaryMethod === "grpo" ? "grpo" : "sft";
  const preferredCandidate = candidateForPreference(
    baseModelCandidates,
    preferredBaseModel,
  );
  const preferredOption = preferredCandidate?.executionOptions.find((option) =>
    option.available && option.methods.includes(requestedInitialMethod)) ?? null;
  const primaryFireworks = destinations.find((destination) =>
    destination.destinationId === "fireworks" &&
    destination.available &&
    destination.methods.includes(requestedInitialMethod));
  const initialDestination = preferredOption?.destinationId
    ?? primaryFireworks?.destinationId
    ?? destinations.find((destination) => destination.destinationId === "local_cpu_fixture" && destination.available)?.destinationId
    ?? destinations.find((destination) => destination.available && destination.destinationId !== "export")?.destinationId
    ?? "local_cpu_fixture";
  const [destinationId, setDestinationId] = useState<TrainingDestinationId>(initialDestination);
  const [compute, setCompute] = useState<ComputeStateResponse | null>(null);
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
    requestedInitialMethod === "grpo"
      ? 8
      : 2);
  const availableTrainExamples = trainingSplitCount(taskset, "train");
  const [trainingExamples, setTrainingExamples] = useState(() =>
    Math.max(
      1,
      Math.min(
        availableTrainExamples,
        requestedInitialMethod === "grpo" && taskset.datasetArtifact
          ? 16
          : 1_000,
      ),
    ));
  const [sequenceLength, setSequenceLength] = useState(() => {
    const recommended = recommendedSequenceLength(
      taskset,
      initialDestination === "fireworks"
        ? FIREWORKS_MAXIMUM_SEQUENCE_LENGTH
        : undefined,
    );
    return requestedInitialMethod === "grpo"
        && taskset.datasetArtifact
        && initialDestination === "fireworks"
      ? Math.max(512, recommended)
      : recommended;
  });
  const [rank, setRank] = useState(initialDestination === "fireworks" ? 8 : 2);
  const [learningRate, setLearningRate] = useState(() =>
    defaultLearningRate(initialCandidate?.preference.modelId ?? ""));
  const [exportApproved, setExportApproved] = useState(false);
  const [maximumCostUsd, setMaximumCostUsd] = useState(FIREWORKS_CONSERVATIVE_ESTIMATE_USD);
  const [retentionDays, setRetentionDays] = useState(7);
  const [rolloutGroupSize, setRolloutGroupSize] = useState(8);
  const [rolloutConcurrency, setRolloutConcurrency] = useState(4);
  const [rolloutMaxOutputTokens, setRolloutMaxOutputTokens] = useState(
    FIREWORKS_DEFAULT_RFT_MAX_OUTPUT_TOKENS,
  );
  const [rftLossMethod, setRftLossMethod] = useState<RftLossMethod>(() =>
    defaultRftLossMethod(taskset));
  const [method, setMethod] = useState<"sft" | "grpo">(requestedInitialMethod);
  const [prepared, setPrepared] = useState<{
    configurationKey: string;
    value: TrainingPreparedStart;
  } | null>(null);
  const destination = destinations.find((item) => item.destinationId === destinationId) ?? null;
  const isBootstrap = method === "sft" && primaryMethod !== "sft" && bootstrap?.method === "sft";
  const approvedExamples = taskset.learningSignals.demonstrations.filter((example) => example.approved).length;
  const evaluationExamples = trainingSplitCount(taskset, "frozen_eval");
  const selectableDevices = useMemo(() => compute?.inventory?.devices.filter((device) => device.available) ?? [], [compute?.inventory?.devices]);
  const trainableModels = useMemo(() => compute?.inventory?.models.filter((model) => model.trainingCompatible && model.modelId && model.revision && model.tokenizerRevision && model.chatTemplateHash) ?? [], [compute?.inventory?.models]);
  const compatibleBaseModels = useMemo(
    () => baseModelCandidates.filter((candidate) =>
      candidate.executionOptions.some((option) =>
        option.destinationId === destinationId && option.methods.includes(method))),
    [baseModelCandidates, destinationId, method],
  );
  const selectedBaseModel = compatibleBaseModels.find((candidate) =>
    candidate.selectionKey === baseModelKey) ?? null;
  const selectedExecutionOption = selectedBaseModel?.executionOptions.find((option) =>
    option.destinationId === destinationId && option.methods.includes(method)) ?? null;
  const baseModelId = selectedBaseModel?.preference.modelId ?? "";
  const selectedModel = selectedBaseModel?.preference.modelAssetId
    ? trainableModels.find((model) =>
        model.id === selectedBaseModel.preference.modelAssetId) ?? null
    : trainableModels.find((model) => model.modelId === baseModelId) ?? null;
  const isFireworks = destinationId === "fireworks";
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
        providerId: "fireworks",
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
    && run.configuration.model.providerId === "fireworks"
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
  const maximumTrainingExamples = method === "grpo"
    && isFireworks
    && taskset.datasetArtifact
    ? Math.max(1, Math.min(32, availableTrainExamples))
    : Math.max(1, Math.min(100_000, availableTrainExamples));
  const approvalReady = !isFireworks || (
    exportApproved &&
    maximumCostUsd >= FIREWORKS_CONSERVATIVE_ESTIMATE_USD &&
    maximumCostUsd <= FIREWORKS_MAXIMUM_CAP_USD &&
    Number.isInteger(retentionDays) &&
    retentionDays >= 1 &&
    retentionDays <= 30
  );
  const executableMethod = method === "sft" || (method === "grpo" && isFireworks);
  const tasksetMethodCompatible = taskset.capabilities.compatibleMethods.includes(method as never)
    || bootstrap?.method === method;
  const compatible = Boolean(
    taskset.readiness?.ready &&
    rftBaselineReady &&
    executableMethod &&
    destination?.available &&
    destination.methods.includes(method as never) &&
    tasksetMethodCompatible &&
    selectedExecutionOption?.available &&
    (selectedBaseModel?.preference.source !== "local" || Boolean(selectedModel)) &&
    approvalReady,
  );
  const incompatibility = !taskset.readiness?.ready
    ? "The Taskset must pass environment, grader, and data readiness before training."
    : !rftBaselineReady
      ? "Verify mixed rewards on the selected train prompts before preparing a paid training quote."
    : !executableMethod
      ? `${method.toUpperCase()} is the primary recommendation but no compatible execution backend is available here.${bootstrap ? " Choose the optional SFT trajectory bootstrap to run the local precursor." : ""}`
      : !selectedBaseModel
        ? `Choose starting weights compatible with ${destinationLabel(destinationId)} and ${method.toUpperCase()}.`
        : !selectedExecutionOption?.available
          ? selectedExecutionOption?.unavailableReason ?? "The selected base model cannot run on this compute destination."
          : selectedBaseModel.preference.source === "local" && !selectedModel
            ? "The selected local model is no longer present in the verified compute inventory. Scan Compute and select it again."
      : !destination?.methods.includes(method as never)
        ? `${destinationLabel(destinationId)} does not execute ${method.toUpperCase()}.`
      : destination?.unavailableReason
        ?? (isFireworks && !exportApproved
          ? "Approve the bounded train-split export before launching Fireworks."
          : isFireworks && (maximumCostUsd < FIREWORKS_CONSERVATIVE_ESTIMATE_USD || maximumCostUsd > FIREWORKS_MAXIMUM_CAP_USD)
            ? `Set a Fireworks cap from $${FIREWORKS_CONSERVATIVE_ESTIMATE_USD.toFixed(2)} through $${FIREWORKS_MAXIMUM_CAP_USD.toFixed(2)}.`
            : isFireworks && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30)
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
  });
  const approval: TrainingStartApproval = {
    exportApproved: isFireworks ? exportApproved : true,
    maximumCostUsd: isFireworks ? maximumCostUsd : 0,
    retentionDays: isFireworks ? retentionDays : null,
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
    void api.computeState(connection).then((state) => {
      if (!active) return;
      setCompute(state);
      setDeviceId(state.settings.defaultDeviceIds[0] ?? "automatic");
    }).catch(() => undefined);
    return () => { active = false; };
  }, [connection]);

  async function start() {
    if (!compatible) return;
    if (isFireworks && !currentPrepared) {
      const next = await onPrepare(destinationId, recipe, approval);
      if (next) setPrepared({ configurationKey, value: next });
      return;
    }
    const completed = isFireworks && currentPrepared
      ? await onConfirmPrepared(currentPrepared, maximumCostUsd)
      : await onStart(destinationId, recipe, approval);
    if (completed) onClose();
  }

  function selectDestination(next: TrainingDestinationId) {
    setDestinationId(next);
    setBaseModelKey((current) => preserveBaseModelSelection(
      baseModelCandidates,
      current,
      next,
      method,
    ));
    if (next === "fireworks") {
      setRank(8);
      if (method === "grpo") {
        setMaxSteps(8);
        if (taskset.datasetArtifact) {
          setTrainingExamples(Math.max(1, Math.min(availableTrainExamples, 16)));
        }
      }
      setSequenceLength(Math.max(
        512,
        recommendedSequenceLength(taskset, FIREWORKS_MAXIMUM_SEQUENCE_LENGTH),
      ));
      return;
    }
    setRank(2);
    setSequenceLength(recommendedSequenceLength(taskset));
  }

  function selectMethod(next: "sft" | "grpo") {
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
      if (destinationId === "fireworks" && taskset.datasetArtifact) {
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
    setMaxSteps(2);
  }
  const preparedQuote = currentPrepared?.plan.estimatedCostUsd ?? null;
  const actionLabel = busy
    ? busyAction === "baseline"
      ? "Base-model test running"
      : currentPrepared ? "Launching…" : isFireworks ? "Preparing…" : "Starting…"
    : currentPrepared && preparedQuote != null
      ? `Launch $${preparedQuote.toFixed(2)} job`
      : isFireworks
        ? "Prepare exact quote"
        : "Start training";

  return <div className="training-dialog-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
    <section className="training-dialog training-start-dialog" role="dialog" aria-modal="true" aria-label="Start training" onMouseDown={(event) => event.stopPropagation()}>
      <div className="training-dialog-header"><div><h2>Start training</h2><p>{taskset.name}</p></div><button type="button" aria-label="Close start training" disabled={busy} onClick={onClose}><X size={16}/></button></div>
      <div className="training-method-tabs" role="tablist" aria-label="Training method">
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
      </div>
      <div className="training-start-fields">
        <label><span>Base model</span><select value={baseModelKey} disabled={busy} onChange={(event) => { const key = event.target.value; const candidate = baseModelCandidates.find((item) => item.selectionKey === key); setBaseModelKey(key); setLearningRate(defaultLearningRate(candidate?.preference.modelId ?? "")); }}><option value="" disabled>Choose compatible starting weights</option>{compatibleBaseModels.map((candidate) => { const option = candidate.executionOptions.find((item) => item.destinationId === destinationId && item.methods.includes(method)); return <option key={candidate.selectionKey} value={candidate.selectionKey} disabled={!option?.available}>{candidate.label} · {candidate.sourceLabel}{option?.available ? "" : ` — ${option?.unavailableReason ?? "Unavailable"}`}</option>; })}</select></label>
        <label><span>Compute</span><select value={destinationId} disabled={busy} onChange={(event) => selectDestination(event.target.value as TrainingDestinationId)}>{destinations.filter((item) => !["custom", "runpod_byoc", "export"].includes(item.destinationId)).map((item) => <option value={item.destinationId} key={item.destinationId} disabled={!item.available}>{destinationLabel(item.destinationId)}{item.available ? "" : ` — ${item.unavailableReason ?? "Unavailable"}`}</option>)}</select></label>
        <label><span>Device</span><select value={deviceId} disabled={busy || destinationId !== "local_cpu_fixture"} onChange={(event) => setDeviceId(event.target.value)}><option value="automatic">Automatic</option>{selectableDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
      </div>
      {isFireworks ? <fieldset className="training-provider-approval">
        <legend>Provider approval</legend>
        {onOpenProviderSettings ? (
          <button
            className="training-text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              onClose();
              onOpenProviderSettings();
            }}
          >
            Manage Fireworks provider
          </button>
        ) : null}
        <label className="training-provider-consent"><input type="checkbox" checked={exportApproved} disabled={busy} onChange={(event) => setExportApproved(event.target.checked)}/><span>Export only the approved train split to Fireworks. Frozen Eval cases and grader secrets stay in OpenPond.</span></label>
        <div className="training-start-fields">
          <label><span>Maximum provider spend (USD)</span><input aria-label="Maximum provider spend (USD)" type="number" min={FIREWORKS_CONSERVATIVE_ESTIMATE_USD} max={FIREWORKS_MAXIMUM_CAP_USD} step={0.01} value={maximumCostUsd} disabled={busy} onChange={(event) => setMaximumCostUsd(event.target.valueAsNumber)}/></label>
          <label><span>Retention record (days)</span><input aria-label="Retention record (days)" type="number" min={1} max={30} step={1} value={retentionDays} disabled={busy} onChange={(event) => setRetentionDays(event.target.valueAsNumber)}/></label>
        </div>
        <p className="training-start-note">Approval is bound server-side to the signed-in OpenPond account at launch.</p>
        {method === "grpo" ? <p className="training-start-note">RFT requires a public HTTPS callback ending in <code>/v1/training/fireworks/rft</code>. Launch fails closed before provider upload when it is missing or invalid.</p> : null}
      </fieldset> : null}
      <dl className="training-start-summary">
        <div><dt>Training data</dt><dd>{method === "grpo" ? `${Math.min(trainingExamples, availableTrainExamples)} of ${availableTrainExamples} approved train prompts` : `${Math.min(trainingExamples, approvedExamples || availableTrainExamples)} approved example${trainingExamples === 1 ? "" : "s"}`}</dd></div>
        <div><dt>Evaluation</dt><dd>{evaluationExamples} test example{evaluationExamples === 1 ? "" : "s"}</dd></div>
        <div><dt>{preparedQuote == null ? "Estimate" : "Exact quote"}</dt><dd>{destinationId === "local_cpu_fixture" ? selectedModel ? `$0 · ${maxSteps} steps × ${sequenceLength} tokens · 15-minute hard stop` : "$0 · 2-minute hard stop" : isFireworks ? preparedQuote == null ? `Prepare a provider-validated quote · hard cap $${Number.isFinite(maximumCostUsd) ? maximumCostUsd.toFixed(2) : "—"}` : `$${preparedQuote.toFixed(2)} · hard cap $${maximumCostUsd.toFixed(2)}` : "Provided before approval"}</dd></div>
        <div><dt>Storage</dt><dd>{isFireworks ? "Portable output imported into app-managed storage" : compute?.settings.modelStorePath ?? "App-managed local storage"}</dd></div>
      </dl>
      {currentPrepared ? (
        <section className="training-prepared-confirmation" aria-label="Confirm paid training launch">
          <div>
            <strong>Ready to launch</strong>
            <span>The quote and prepared data are fixed to this confirmation.</span>
          </div>
          <dl className="training-start-summary">
            <div><dt>Account</dt><dd>{currentPrepared.approvalActor ?? "Local user"}</dd></div>
            <div><dt>Provider</dt><dd>{destinationLabel(currentPrepared.plan.destinationId)}</dd></div>
            <div><dt>Model</dt><dd>{modelLabel(currentPrepared.plan.recipe.method === "sft" || currentPrepared.plan.recipe.method === "grpo" ? currentPrepared.plan.recipe.baseModel.id : "")}</dd></div>
            <div><dt>Method</dt><dd>{currentPrepared.plan.recipe.method === "grpo" ? `RFT · ${rftLossLabel(currentPrepared.plan.recipe.loss.method)}` : `${trainingMethodLabel(currentPrepared.plan.recipe.method)} · ${currentPrepared.plan.recipe.parameterization.toUpperCase()}`}</dd></div>
            <div><dt>Quote</dt><dd>{preparedQuote == null ? "Unavailable" : `$${preparedQuote.toFixed(2)}`}</dd></div>
            <div><dt>Maximum</dt><dd>${maximumCostUsd.toFixed(2)}</dd></div>
            <div><dt>Retention</dt><dd>{currentPrepared.plan.dataPolicy.retentionDays} days</dd></div>
            <div><dt>Prepared data</dt><dd>{formatBytes(currentPrepared.bundle.totalSizeBytes)} · verified</dd></div>
            {currentPrepared.plan.rftSignalGate ? <div><dt>Train signal</dt><dd>{currentPrepared.plan.rftSignalGate.signal.mixedRewardGroups} mixed groups · verified</dd></div> : null}
          </dl>
          <p>No Fireworks dataset or job exists until you launch.</p>
        </section>
      ) : null}
      {method === "grpo" && isFireworks ? (
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
            {!rftBaselineReady ? <span>{taskset.datasetArtifact ? "The check" : "The test"} may start one temporary Fireworks deployment, capped at 10 minutes (up to $1.17), and removes it when finished.</span> : null}
          </div>
          {!rftBaselineReady ? <button
              className="training-button secondary"
              type="button"
              disabled={baselineBusy || !baseModelId || !onRunBaseline}
              onClick={() => {
                if (!onRunBaseline || !baseModelId) return;
                void onRunBaseline(
                  { providerId: "fireworks", modelId: baseModelId },
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
      <details className="training-start-advanced"><summary>Advanced settings</summary><div className="training-start-fields"><label><span>Training examples</span><input type="number" min={1} max={maximumTrainingExamples} value={trainingExamples} onChange={(event) => setTrainingExamples(Math.max(1, Math.min(maximumTrainingExamples, event.target.valueAsNumber || 1)))}/></label><label><span>Optimizer steps</span><input type="number" min={1} max={1000} value={maxSteps} onChange={(event) => setMaxSteps(event.target.valueAsNumber || 1)}/></label><label><span>{method === "grpo" ? "Prompt length" : "Sequence length"}</span><input type="number" min={16} max={isFireworks ? FIREWORKS_MAXIMUM_SEQUENCE_LENGTH : 4_096} value={sequenceLength} onChange={(event) => setSequenceLength(event.target.valueAsNumber || 64)}/></label>{method === "grpo" ? <label><span>Maximum output</span><input type="number" min={16} max={FIREWORKS_MAXIMUM_RFT_OUTPUT_TOKENS} value={rolloutMaxOutputTokens} onChange={(event) => setRolloutMaxOutputTokens(Math.max(16, Math.min(FIREWORKS_MAXIMUM_RFT_OUTPUT_TOKENS, event.target.valueAsNumber || FIREWORKS_DEFAULT_RFT_MAX_OUTPUT_TOKENS)))}/></label> : null}<label><span>LoRA rank</span><input type="number" min={1} max={256} value={rank} onChange={(event) => setRank(event.target.valueAsNumber || 2)}/></label><label><span>Learning rate</span><input type="number" min={0.000001} max={0.1} step={0.0001} value={learningRate} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setLearningRate(value); }}/></label>{method === "grpo" ? <><label><span>RL loss</span><select aria-label="RL loss" value={rftLossMethod} onChange={(event) => setRftLossMethod(event.target.value as RftLossMethod)}><option value="dapo">DAPO</option><option value="grpo">GRPO</option><option value="gspo-token">GSPO-token</option></select></label><label><span>Rollouts per prompt</span><input type="number" min={2} max={16} value={rolloutGroupSize} onChange={(event) => setRolloutGroupSize(event.target.valueAsNumber || 8)}/></label><label><span>Concurrent rollouts</span><input type="number" min={1} max={16} value={rolloutConcurrency} onChange={(event) => setRolloutConcurrency(event.target.valueAsNumber || 4)}/></label></> : null}</div></details>
      {!compatible && (rftBaselineReady || method !== "grpo" || !isFireworks) ? <div className="training-banner error training-dialog-error">{incompatibility ?? "This setup is unavailable."}</div> : destination?.nonProduction ? <p className="training-start-note">This local worker is an experimental correctness run. It does not claim useful model quality.</p> : null}
      <div className="training-dialog-actions"><button className="training-button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="training-button" type="button" disabled={busy || !compatible} onClick={() => void start()}>{actionLabel}</button></div>
    </section>
  </div>;
}

function baselineRunLabel(run: TasksetBaselineRun | null): string {
  if (!run) return "Starting train-signal check…";
  if (run.status === "cancelling") return "Cancelling train-signal check…";
  if (run.progress.stage === "provisioning") return "Preparing Fireworks capacity…";
  if (run.progress.stage === "running") {
    return `Checking train signal… ${run.progress.completedAttempts}/${run.progress.totalAttempts}`;
  }
  if (run.progress.stage === "cleaning_up") return "Removing temporary deployment…";
  return "Checking train signal…";
}

export function trainingRecipe(input: { method: string; taskset: Taskset; destinationId: TrainingDestinationId; baseModelId: string; maxSteps: number; sequenceLength: number; rank: number; learningRate: number; model: ModelAsset | null; rolloutGroupSize: number; rolloutConcurrency: number; rolloutMaxOutputTokens: number; trainingExamples: number; rftLossMethod?: RftLossMethod }): TrainingRecipe {
  if (input.method === "grpo" && input.destinationId === "fireworks") {
    const crossSystem =
      input.taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
      || input.taskset.environment.metadata.toolContractHash
        === CROSS_SYSTEM_TOOL_CONTRACT_HASH;
    const grader = input.taskset.graders.find((candidate) =>
      candidate.rewardEligible);
    return {
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: { id: input.baseModelId, revision: "fireworks-managed-model-resource-v1", tokenizerRevision: "fireworks-provider-managed", chatTemplateHash: "fireworks-qwen3-chat-v1" },
      dataset: {
        trainSplit: "train",
        validationSplit: "frozen_eval",
        maxPromptTokens: input.sequenceLength,
        maxExamples: input.trainingExamples,
        selectionStrategy: input.taskset.datasetArtifact
          ? "rft_easy_curriculum_v1"
          : "stable_hash_top_n",
      },
      lora: { rank: input.rank },
      rollout: { groupSize: input.rolloutGroupSize, concurrency: input.rolloutConcurrency, maxTurns: crossSystem ? 15 : 1, maxOutputTokens: input.rolloutMaxOutputTokens, temperature: 0.8, topP: 0.95, seed: 17 },
      optimizer: { learningRate: input.learningRate, maxSteps: input.maxSteps },
      loss: { method: input.rftLossMethod ?? defaultRftLossMethod(input.taskset), klBeta: null },
      reward: crossSystem
        ? { graderId: "cross-system-exact-verifier", graderHash: "server-derived-grader-hash", environmentId: "cross-system-operations", environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH }
        : { graderId: grader?.id ?? "math_final_answer", graderHash: "server-derived-grader-hash", environmentId: DATASET_EXACT_ANSWER_ENVIRONMENT_ID, environmentVersion: DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION, toolContractHash: DATASET_NO_TOOLS_CONTRACT_HASH },
      resourceLimits: {
        wallTimeMs: 180_000,
        maxRollouts: Math.max(
          input.rolloutGroupSize,
          input.trainingExamples * input.rolloutGroupSize,
        ),
        maxPayloadBytes: 1_000_000,
      },
    };
  }
  if (input.destinationId === "fireworks") return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: input.baseModelId, revision: "fireworks-managed-model-resource-v1", tokenizerRevision: "fireworks-provider-managed", chatTemplateHash: "fireworks-qwen3-chat-v1" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength, maxExamples: input.trainingExamples }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0.05, targetModules: SMOLLM2_LORA_TARGET_MODULES }, optimizer: { learningRate: input.learningRate, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 1, memoryBytes: 1_000_000_000, wallTimeMs: 3_600_000 } };
  if (!input.model?.modelId || !input.model.revision || !input.model.tokenizerRevision || !input.model.chatTemplateHash) return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v2-seed-17-context-512", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength, maxExamples: input.trainingExamples }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: input.learningRate, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 4, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } };
  return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: input.model.modelId, revision: input.model.revision, tokenizerRevision: input.model.tokenizerRevision, chatTemplateHash: input.model.chatTemplateHash }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength, maxExamples: input.trainingExamples }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0.05, targetModules: SMOLLM2_LORA_TARGET_MODULES }, optimizer: { learningRate: input.learningRate, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 4, memoryBytes: 8_000_000_000, wallTimeMs: 900_000 } };
}

export function defaultRftLossMethod(taskset: Taskset): RftLossMethod {
  const dapoSource = taskset.sourceRefs.some((source) => {
    const metadata = source.metadata as Record<string, unknown>;
    const repositoryId = "repositoryId" in source
      ? String(source.repositoryId)
      : "";
    return repositoryId.toLowerCase().includes("dapo-math")
      || source.title.toLowerCase().includes("dapo-math")
      || String(metadata.datasetName ?? "").toLowerCase().includes("dapo-math");
  });
  return dapoSource ? "dapo" : "grpo";
}

function rftLossLabel(method: RftLossMethod): string {
  if (method === "gspo-token") return "GSPO-token";
  return method.toUpperCase();
}

export function preserveBaseModelSelection(
  candidates: BaseModelCandidate[],
  currentSelectionKey: string,
  destinationId: TrainingDestinationId,
  method: "sft" | "grpo",
): string {
  const current = candidates.find((candidate) =>
    candidate.selectionKey === currentSelectionKey);
  return current?.executionOptions.some((option) =>
    option.destinationId === destinationId && option.methods.includes(method))
    ? currentSelectionKey
    : "";
}

function defaultLearningRate(modelId: string): number { return modelId === "openpond/tiny-cpu-gpt2-fixture" ? 0.01 : 0.0002; }
function tasksetMethod(taskset: Taskset) { const authored = taskset.metadata.trainingMethod; if (typeof authored === "string" && authored !== "none") return authored; return taskset.readiness?.recommendedMethod && taskset.readiness.recommendedMethod !== "none" ? taskset.readiness.recommendedMethod : "sft"; }
function selectableMethods(taskset: Taskset): Array<"sft" | "grpo"> {
  const methods = new Set<"sft" | "grpo">();
  for (const method of taskset.capabilities.compatibleMethods) {
    if (method === "sft" || method === "grpo") methods.add(method);
  }
  if (taskset.readiness?.trainingPath?.bootstrap?.method === "sft") methods.add("sft");
  if (taskset.readiness?.trainingPath?.primaryMethod === "grpo") methods.add("grpo");
  const ordered: Array<"sft" | "grpo"> = [];
  if (methods.has("sft")) ordered.push("sft");
  if (methods.has("grpo")) ordered.push("grpo");
  return ordered.length ? ordered : ["sft"];
}
function trainingSplitCount(taskset: Taskset, split: "train" | "frozen_eval"): number {
  return taskset.datasetArtifact?.splitCounts[split]
    ?? taskset.tasks.filter((task) => task.split === split).length;
}
function destinationLabel(destination: string) { const labels: Record<string, string> = { export: "Export only", local_cpu_fixture: "Local CPU", local_cuda: "Local NVIDIA GPU", local_mlx: "Apple Silicon", ssh_gpu: "SSH GPU", prime_hosted: "Prime hosted", fireworks: "Fireworks", openpond_managed: "OpenPond managed" }; return labels[destination] ?? destination.replaceAll("_", " "); }
function candidateForPreference(
  candidates: BaseModelCandidate[],
  preference: BaseModelPreference | null,
): BaseModelCandidate | null {
  if (!preference) return null;
  return candidates.find((candidate) =>
    candidate.preference.modelId === preference.modelId
    && candidate.preference.source === preference.source
    && candidate.preference.revision === preference.revision
    && candidate.preference.modelAssetId === preference.modelAssetId)
    ?? candidates.find((candidate) =>
      candidate.preference.modelId === preference.modelId)
    ?? null;
}

function defaultCandidateForDestination(
  candidates: BaseModelCandidate[],
  destinationId: TrainingDestinationId,
  method: "sft" | "grpo",
): BaseModelCandidate | null {
  const compatible = candidates.filter((candidate) =>
    candidate.executionOptions.some((option) =>
      option.destinationId === destinationId
      && option.available
      && option.methods.includes(method)));
  if (destinationId === "fireworks") {
    return compatible.find((candidate) =>
      candidate.preference.modelId === FIREWORKS_DEFAULT_MODEL)
      ?? compatible[0]
      ?? null;
  }
  return compatible[0] ?? null;
}

function modelLabel(modelId: string) {
  if (modelId === "accounts/fireworks/models/qwen3-8b") {
    return "Qwen3 8B · Fireworks managed LoRA";
  }
  if (modelId === "accounts/fireworks/models/qwen3-0p6b") {
    return "Qwen3 0.6B · Fireworks managed LoRA";
  }
  return modelId.split("/").at(-1) ?? modelId;
}
function formatBytes(value: number | null): string {
  if (value == null) return "size unknown";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_024 / 1_024).toFixed(0)} MB`;
}
