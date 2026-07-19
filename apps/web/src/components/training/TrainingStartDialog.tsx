import { useEffect, useMemo, useState } from "react";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  type ComputeStateResponse,
  type ModelAsset,
  type Taskset,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
  type TrainingPreparedStart,
  type TrainingRecipe,
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

export type TrainingStartApproval = {
  exportApproved: boolean;
  maximumCostUsd: number | null;
  retentionDays: number | null;
  region: string | null;
};

export function TrainingStartDialog({
  connection,
  taskset,
  modelId = null,
  destinations,
  initialMethod,
  preferredBaseModelId = null,
  busy,
  onClose,
  onStart,
  onPrepare,
  onConfirmPrepared,
}: {
  connection: ClientConnection | null;
  taskset: Taskset;
  modelId?: string | null;
  destinations: TrainingDestinationCapabilities[];
  initialMethod?: "sft" | "grpo";
  preferredBaseModelId?: string | null;
  busy: boolean;
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
}) {
  const trainingPath = taskset.readiness?.trainingPath ?? null;
  const primaryMethod = trainingPath?.primaryMethod ?? tasksetMethod(taskset);
  const bootstrap = trainingPath?.bootstrap ?? null;
  const methodOptions = selectableMethods(taskset);
  const requestedInitialMethod = initialMethod && methodOptions.includes(initialMethod)
    ? initialMethod
    : primaryMethod === "grpo" ? "grpo" : "sft";
  const primaryFireworks = destinations.find((destination) =>
    destination.destinationId === "fireworks" &&
    destination.available &&
    destination.methods.includes(requestedInitialMethod));
  const initialDestination = primaryFireworks?.destinationId
    ?? destinations.find((destination) => destination.destinationId === "local_cpu_fixture" && destination.available)?.destinationId
    ?? destinations.find((destination) => destination.available && destination.destinationId !== "export")?.destinationId
    ?? "local_cpu_fixture";
  const [destinationId, setDestinationId] = useState<TrainingDestinationId>(initialDestination);
  const [compute, setCompute] = useState<ComputeStateResponse | null>(null);
  const fireworksModelAllowlist = destinations.find((destination) =>
    destination.destinationId === "fireworks")?.modelAllowlist ?? [];
  const initialFireworksModel = preferredBaseModelId
    && fireworksModelAllowlist.includes(preferredBaseModelId)
    ? preferredBaseModelId
    : preferredFireworksModel(fireworksModelAllowlist);
  const [baseModelId, setBaseModelId] = useState(
    initialDestination === "fireworks"
      ? initialFireworksModel
      : "openpond/tiny-cpu-gpt2-fixture",
  );
  const [deviceId, setDeviceId] = useState("automatic");
  const [maxSteps, setMaxSteps] = useState(() =>
    requestedInitialMethod === "grpo"
      ? Math.min(10, Math.max(1, taskset.tasks.filter((task) => task.split === "train").length))
      : 2);
  const [sequenceLength, setSequenceLength] = useState(() => recommendedSequenceLength(
    taskset,
    initialDestination === "fireworks" ? FIREWORKS_MAXIMUM_SEQUENCE_LENGTH : undefined,
  ));
  const [rank, setRank] = useState(initialDestination === "fireworks" ? 8 : 2);
  const [learningRate, setLearningRate] = useState(() => defaultLearningRate(baseModelId));
  const [exportApproved, setExportApproved] = useState(false);
  const [maximumCostUsd, setMaximumCostUsd] = useState(FIREWORKS_CONSERVATIVE_ESTIMATE_USD);
  const [retentionDays, setRetentionDays] = useState(7);
  const [rolloutGroupSize, setRolloutGroupSize] = useState(8);
  const [rolloutConcurrency, setRolloutConcurrency] = useState(4);
  const [method, setMethod] = useState<"sft" | "grpo">(requestedInitialMethod);
  const [prepared, setPrepared] = useState<{
    configurationKey: string;
    value: TrainingPreparedStart;
  } | null>(null);
  const destination = destinations.find((item) => item.destinationId === destinationId) ?? null;
  const isBootstrap = method === "sft" && primaryMethod !== "sft" && bootstrap?.method === "sft";
  const approvedExamples = taskset.learningSignals.demonstrations.filter((example) => example.approved).length;
  const evaluationExamples = taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  const selectableDevices = useMemo(() => compute?.inventory?.devices.filter((device) => device.available) ?? [], [compute?.inventory?.devices]);
  const trainableModels = useMemo(() => compute?.inventory?.models.filter((model) => model.trainingCompatible && model.modelId && model.revision && model.tokenizerRevision && model.chatTemplateHash) ?? [], [compute?.inventory?.models]);
  const selectedModel = trainableModels.find((model) => model.modelId === baseModelId) ?? null;
  const isFireworks = destinationId === "fireworks";
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
    executableMethod &&
    destination?.available &&
    destination.methods.includes(method as never) &&
    tasksetMethodCompatible &&
    approvalReady,
  );
  const incompatibility = !taskset.readiness?.ready
    ? "The Taskset must pass environment, grader, and data readiness before training."
    : !executableMethod
      ? `${method.toUpperCase()} is the primary recommendation but no compatible execution backend is available here.${bootstrap ? " Choose the optional SFT trajectory bootstrap to run the local precursor." : ""}`
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
      const smol = state.inventory?.models.find((model) => model.modelId === "HuggingFaceTB/SmolLM2-135M-Instruct" && model.trainingCompatible);
      if (destinationId !== "fireworks" && smol?.modelId) {
        setBaseModelId(smol.modelId);
        setLearningRate(defaultLearningRate(smol.modelId));
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [connection, destinationId]);

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
    if (next === "fireworks") {
      const allowlist = destinations.find((candidate) =>
        candidate.destinationId === "fireworks")?.modelAllowlist ?? [];
      const modelId = preferredBaseModelId && allowlist.includes(preferredBaseModelId)
        ? preferredBaseModelId
        : preferredFireworksModel(allowlist);
      setBaseModelId(modelId);
      setLearningRate(defaultLearningRate(modelId));
      setRank(8);
      if (method === "grpo") {
        setMaxSteps(Math.min(
          10,
          Math.max(1, taskset.tasks.filter((task) => task.split === "train").length),
        ));
      }
      setSequenceLength(Math.max(
        512,
        recommendedSequenceLength(taskset, FIREWORKS_MAXIMUM_SEQUENCE_LENGTH),
      ));
      return;
    }
    setBaseModelId("openpond/tiny-cpu-gpt2-fixture");
    setLearningRate(defaultLearningRate("openpond/tiny-cpu-gpt2-fixture"));
    setRank(2);
    setSequenceLength(recommendedSequenceLength(taskset));
  }

  function selectMethod(next: "sft" | "grpo") {
    setMethod(next);
    setPrepared(null);
    if (next === "grpo") {
      setMaxSteps(Math.min(
        10,
        Math.max(1, taskset.tasks.filter((task) => task.split === "train").length),
      ));
      return;
    }
    setMaxSteps(2);
  }
  const preparedQuote = currentPrepared?.plan.estimatedCostUsd ?? null;
  const actionLabel = busy
    ? currentPrepared ? "Launching…" : isFireworks ? "Preparing…" : "Starting…"
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
        <label><span>Base model</span><select value={baseModelId} disabled={busy} onChange={(event) => { const modelId = event.target.value; setBaseModelId(modelId); setLearningRate(defaultLearningRate(modelId)); }}>{isFireworks ? (destination?.modelAllowlist.length ? destination.modelAllowlist : [FIREWORKS_DEFAULT_MODEL]).map((modelId) => <option key={modelId} value={modelId}>{modelLabel(modelId)}</option>) : <><option value="openpond/tiny-cpu-gpt2-fixture">Tiny CPU correctness fixture</option>{trainableModels.map((model) => <option key={model.id} value={model.modelId ?? model.id}>{model.name} · {formatBytes(model.sizeBytes)}</option>)}</>}</select></label>
        <label><span>Compute</span><select value={destinationId} disabled={busy} onChange={(event) => selectDestination(event.target.value as TrainingDestinationId)}>{destinations.filter((item) => !["custom", "runpod_byoc", "export"].includes(item.destinationId)).map((item) => <option value={item.destinationId} key={item.destinationId} disabled={!item.available}>{destinationLabel(item.destinationId)}{item.available ? "" : ` — ${item.unavailableReason ?? "Unavailable"}`}</option>)}</select></label>
        <label><span>Device</span><select value={deviceId} disabled={busy || destinationId !== "local_cpu_fixture"} onChange={(event) => setDeviceId(event.target.value)}><option value="automatic">Automatic</option>{selectableDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
      </div>
      {isFireworks ? <fieldset className="training-provider-approval">
        <legend>Provider approval</legend>
        <label className="training-provider-consent"><input type="checkbox" checked={exportApproved} disabled={busy} onChange={(event) => setExportApproved(event.target.checked)}/><span>Export only the approved train split to Fireworks. Frozen Eval cases and grader secrets stay in OpenPond.</span></label>
        <div className="training-start-fields">
          <label><span>Maximum provider spend (USD)</span><input aria-label="Maximum provider spend (USD)" type="number" min={FIREWORKS_CONSERVATIVE_ESTIMATE_USD} max={FIREWORKS_MAXIMUM_CAP_USD} step={0.01} value={maximumCostUsd} disabled={busy} onChange={(event) => setMaximumCostUsd(event.target.valueAsNumber)}/></label>
          <label><span>Retention record (days)</span><input aria-label="Retention record (days)" type="number" min={1} max={30} step={1} value={retentionDays} disabled={busy} onChange={(event) => setRetentionDays(event.target.valueAsNumber)}/></label>
        </div>
        <p className="training-start-note">Approval is bound server-side to the signed-in OpenPond account at launch.</p>
        {method === "grpo" ? <p className="training-start-note">RFT requires a public HTTPS callback ending in <code>/v1/training/fireworks/rft</code>. Launch fails closed before provider upload when it is missing or invalid.</p> : null}
      </fieldset> : null}
      <dl className="training-start-summary">
        <div><dt>Training data</dt><dd>{method === "grpo" ? `${taskset.tasks.filter((task) => task.split === "train").length} approved train prompts` : `${approvedExamples} approved example${approvedExamples === 1 ? "" : "s"}`}</dd></div>
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
            <div><dt>Method</dt><dd>{trainingMethodLabel(currentPrepared.plan.recipe.method)} · {currentPrepared.plan.recipe.parameterization.toUpperCase()}</dd></div>
            <div><dt>Quote</dt><dd>{preparedQuote == null ? "Unavailable" : `$${preparedQuote.toFixed(2)}`}</dd></div>
            <div><dt>Maximum</dt><dd>${maximumCostUsd.toFixed(2)}</dd></div>
            <div><dt>Retention</dt><dd>{currentPrepared.plan.dataPolicy.retentionDays} days</dd></div>
            <div><dt>Prepared data</dt><dd>{formatBytes(currentPrepared.bundle.totalSizeBytes)} · verified</dd></div>
          </dl>
          <p>No Fireworks dataset or job exists until you launch.</p>
        </section>
      ) : null}
      {isBootstrap && bootstrap ? <div className="training-bootstrap-limitations"><strong>Supervised precursor</strong><p>This SFT run teaches the approved tool trajectories. It does not replace reinforcement training.</p><ul>{bootstrap.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div> : null}
      <details className="training-start-advanced"><summary>Advanced settings</summary><div className="training-start-fields"><label><span>{method === "grpo" ? "Prompts per update" : "Steps"}</span><input type="number" min={1} max={1000} value={maxSteps} onChange={(event) => setMaxSteps(event.target.valueAsNumber || 1)}/></label><label><span>{method === "grpo" ? "Prompt length" : "Sequence length"}</span><input type="number" min={16} max={isFireworks ? FIREWORKS_MAXIMUM_SEQUENCE_LENGTH : 4_096} value={sequenceLength} onChange={(event) => setSequenceLength(event.target.valueAsNumber || 64)}/></label><label><span>LoRA rank</span><input type="number" min={1} max={256} value={rank} onChange={(event) => setRank(event.target.valueAsNumber || 2)}/></label><label><span>Learning rate</span><input type="number" min={0.000001} max={0.1} step={0.0001} value={learningRate} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setLearningRate(value); }}/></label>{method === "grpo" ? <><label><span>Rollouts per prompt</span><input type="number" min={2} max={16} value={rolloutGroupSize} onChange={(event) => setRolloutGroupSize(event.target.valueAsNumber || 8)}/></label><label><span>Concurrent rollouts</span><input type="number" min={1} max={16} value={rolloutConcurrency} onChange={(event) => setRolloutConcurrency(event.target.valueAsNumber || 4)}/></label></> : null}</div></details>
      {!compatible ? <div className="training-banner error training-dialog-error">{incompatibility ?? "This setup is unavailable."}</div> : destination?.nonProduction ? <p className="training-start-note">This local worker is an experimental correctness run. It does not claim useful model quality.</p> : null}
      <div className="training-dialog-actions"><button className="training-button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="training-button" type="button" disabled={busy || !compatible} onClick={() => void start()}>{actionLabel}</button></div>
    </section>
  </div>;
}

export function trainingRecipe(input: { method: string; taskset: Taskset; destinationId: TrainingDestinationId; baseModelId: string; maxSteps: number; sequenceLength: number; rank: number; learningRate: number; model: ModelAsset | null; rolloutGroupSize: number; rolloutConcurrency: number }): TrainingRecipe {
  if (input.method === "grpo" && input.destinationId === "fireworks") {
    return {
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: { id: input.baseModelId, revision: "fireworks-managed-model-resource-v1", tokenizerRevision: "fireworks-provider-managed", chatTemplateHash: "fireworks-qwen3-chat-v1" },
      dataset: { trainSplit: "train", validationSplit: "frozen_eval", maxPromptTokens: input.sequenceLength },
      lora: { rank: input.rank },
      rollout: { groupSize: input.rolloutGroupSize, concurrency: input.rolloutConcurrency, maxTurns: 15, maxOutputTokens: Math.min(2048, input.sequenceLength), temperature: 0.8, topP: 0.95, seed: 17 },
      optimizer: { learningRate: input.learningRate, maxSteps: input.maxSteps },
      reward: { graderId: "cross-system-exact-verifier", graderHash: "server-derived-grader-hash", environmentId: "cross-system-operations", environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
      resourceLimits: {
        wallTimeMs: 180_000,
        maxRollouts: Math.max(
          input.rolloutGroupSize,
          input.taskset.tasks.filter((task) => task.split === "train").length
            * input.rolloutGroupSize,
        ),
        maxPayloadBytes: 1_000_000,
      },
    };
  }
  if (input.destinationId === "fireworks") return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: input.baseModelId, revision: "fireworks-managed-model-resource-v1", tokenizerRevision: "fireworks-provider-managed", chatTemplateHash: "fireworks-qwen3-chat-v1" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0.05, targetModules: SMOLLM2_LORA_TARGET_MODULES }, optimizer: { learningRate: input.learningRate, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 1, memoryBytes: 1_000_000_000, wallTimeMs: 3_600_000 } };
  if (!input.model?.modelId || !input.model.revision || !input.model.tokenizerRevision || !input.model.chatTemplateHash) return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v2-seed-17-context-512", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: input.learningRate, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 4, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } };
  return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: input.model.modelId, revision: input.model.revision, tokenizerRevision: input.model.tokenizerRevision, chatTemplateHash: input.model.chatTemplateHash }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0.05, targetModules: SMOLLM2_LORA_TARGET_MODULES }, optimizer: { learningRate: input.learningRate, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 4, memoryBytes: 8_000_000_000, wallTimeMs: 900_000 } };
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
function destinationLabel(destination: string) { const labels: Record<string, string> = { export: "Export only", local_cpu_fixture: "Local CPU", local_cuda: "Local NVIDIA GPU", local_mlx: "Apple Silicon", ssh_gpu: "SSH GPU", prime_hosted: "Prime hosted", fireworks: "Fireworks", openpond_managed: "OpenPond managed" }; return labels[destination] ?? destination.replaceAll("_", " "); }
function preferredFireworksModel(modelAllowlist: string[]): string {
  return modelAllowlist.includes(FIREWORKS_DEFAULT_MODEL)
    ? FIREWORKS_DEFAULT_MODEL
    : modelAllowlist[0] ?? FIREWORKS_DEFAULT_MODEL;
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
