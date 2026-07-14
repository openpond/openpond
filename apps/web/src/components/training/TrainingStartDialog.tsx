import { useEffect, useMemo, useState } from "react";
import type { ComputeStateResponse, ModelAsset, SftRecipe, Taskset, TrainingDestinationCapabilities, TrainingDestinationId } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { X } from "../icons";

export function TrainingStartDialog({
  connection,
  taskset,
  destinations,
  busy,
  onClose,
  onStart,
}: {
  connection: ClientConnection | null;
  taskset: Taskset;
  destinations: TrainingDestinationCapabilities[];
  busy: boolean;
  onClose: () => void;
  onStart: (destinationId: TrainingDestinationId, recipe: SftRecipe) => Promise<boolean>;
}) {
  const initialDestination = destinations.find((destination) => destination.destinationId === "local_cpu_fixture" && destination.available)?.destinationId
    ?? destinations.find((destination) => destination.available && destination.destinationId !== "export")?.destinationId
    ?? "local_cpu_fixture";
  const [destinationId, setDestinationId] = useState<TrainingDestinationId>(initialDestination);
  const [compute, setCompute] = useState<ComputeStateResponse | null>(null);
  const [baseModelId, setBaseModelId] = useState("openpond/tiny-cpu-gpt2-fixture");
  const [deviceId, setDeviceId] = useState("automatic");
  const [maxSteps, setMaxSteps] = useState(2);
  const [sequenceLength, setSequenceLength] = useState(64);
  const [rank, setRank] = useState(2);
  const trainingPath = taskset.readiness?.trainingPath ?? null;
  const [stage, setStage] = useState<"primary" | "bootstrap">("primary");
  const destination = destinations.find((item) => item.destinationId === destinationId) ?? null;
  const primaryMethod = trainingPath?.primaryMethod ?? tasksetMethod(taskset);
  const bootstrap = trainingPath?.bootstrap ?? null;
  const method = stage === "bootstrap" && bootstrap ? bootstrap.method : primaryMethod;
  const approvedExamples = taskset.learningSignals.demonstrations.filter((example) => example.approved).length;
  const evaluationExamples = taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  const selectableDevices = useMemo(() => compute?.inventory?.devices.filter((device) => device.available) ?? [], [compute?.inventory?.devices]);
  const trainableModels = useMemo(() => compute?.inventory?.models.filter((model) => model.trainingCompatible && model.modelId && model.revision && model.tokenizerRevision && model.chatTemplateHash) ?? [], [compute?.inventory?.models]);
  const selectedModel = trainableModels.find((model) => model.modelId === baseModelId) ?? null;
  const compatible = Boolean(taskset.readiness?.ready && method === "sft" && destination?.available && destination.methods.includes("sft") && taskset.capabilities.compatibleMethods.includes("sft"));
  const incompatibility = !taskset.readiness?.ready
    ? "The Taskset must pass environment, grader, and data readiness before training."
    : method !== "sft"
      ? `${method.toUpperCase()} is the primary recommendation but no compatible execution backend is available here.${bootstrap ? " Choose the optional SFT trajectory bootstrap to run the local precursor." : ""}`
      : destination?.unavailableReason ?? null;

  useEffect(() => {
    if (!connection) return;
    let active = true;
    void api.computeState(connection).then((state) => {
      if (!active) return;
      setCompute(state);
      setDeviceId(state.settings.defaultDeviceIds[0] ?? "automatic");
      const smol = state.inventory?.models.find((model) => model.modelId === "HuggingFaceTB/SmolLM2-135M-Instruct" && model.trainingCompatible);
      if (smol?.modelId) setBaseModelId(smol.modelId);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [connection]);

  async function start() {
    if (!compatible) return;
    const completed = await onStart(destinationId, sftRecipe({ maxSteps, sequenceLength, rank, model: selectedModel }));
    if (completed) onClose();
  }

  return <div className="training-dialog-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
    <section className="training-dialog training-start-dialog" role="dialog" aria-modal="true" aria-label="Start training" onMouseDown={(event) => event.stopPropagation()}>
      <div className="training-dialog-header"><div><h2>Start training</h2><p>{taskset.name}</p></div><button type="button" aria-label="Close start training" disabled={busy} onClick={onClose}><X size={16}/></button></div>
      <div className="training-start-fields">
        <label><span>Training stage</span><select value={stage} disabled={busy || !bootstrap} onChange={(event) => setStage(event.target.value as "primary" | "bootstrap")}><option value="primary">Primary · {primaryMethod.toUpperCase()}</option>{bootstrap ? <option value="bootstrap">Precursor · SFT trajectory bootstrap</option> : null}</select></label>
        <label><span>Base model</span><select value={baseModelId} disabled={busy} onChange={(event) => setBaseModelId(event.target.value)}><option value="openpond/tiny-cpu-gpt2-fixture">Tiny CPU correctness fixture</option>{trainableModels.map((model) => <option key={model.id} value={model.modelId ?? model.id}>{model.name} · {formatBytes(model.sizeBytes)}</option>)}</select></label>
        <label><span>Compute</span><select value={destinationId} disabled={busy} onChange={(event) => setDestinationId(event.target.value as TrainingDestinationId)}>{destinations.filter((item) => !["custom", "runpod_byoc", "export"].includes(item.destinationId)).map((item) => <option value={item.destinationId} key={item.destinationId} disabled={!item.available}>{destinationLabel(item.destinationId)}{item.available ? "" : ` — ${item.unavailableReason ?? "Unavailable"}`}</option>)}</select></label>
        <label><span>Device</span><select value={deviceId} disabled={busy || destinationId !== "local_cpu_fixture"} onChange={(event) => setDeviceId(event.target.value)}><option value="automatic">Automatic</option>{selectableDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
      </div>
      <dl className="training-start-summary">
        <div><dt>Training data</dt><dd>{approvedExamples} approved example{approvedExamples === 1 ? "" : "s"}</dd></div>
        <div><dt>Evaluation</dt><dd>{evaluationExamples} test example{evaluationExamples === 1 ? "" : "s"}</dd></div>
        <div><dt>Estimate</dt><dd>{destinationId === "local_cpu_fixture" ? selectedModel ? "$0 · about 3–10 minutes on this CPU" : "$0 · about 1–2 minutes" : "Provided before approval"}</dd></div>
        <div><dt>Storage</dt><dd>{compute?.settings.modelStorePath ?? "App-managed local storage"}</dd></div>
      </dl>
      {stage === "bootstrap" && bootstrap ? <div className="training-bootstrap-limitations"><strong>Bootstrap limitations</strong><ul>{bootstrap.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div> : null}
      <details className="training-start-advanced"><summary>Advanced settings</summary><div className="training-start-fields"><label><span>Steps</span><input type="number" min={1} max={1000} value={maxSteps} onChange={(event) => setMaxSteps(event.target.valueAsNumber || 1)}/></label><label><span>Sequence length</span><input type="number" min={16} max={4096} value={sequenceLength} onChange={(event) => setSequenceLength(event.target.valueAsNumber || 64)}/></label><label><span>LoRA rank</span><input type="number" min={1} max={256} value={rank} onChange={(event) => setRank(event.target.valueAsNumber || 2)}/></label></div></details>
      {!compatible ? <div className="training-banner error training-dialog-error">{incompatibility ?? "This setup is unavailable."}</div> : destination?.nonProduction ? <p className="training-start-note">This local worker is an experimental correctness run. It does not claim useful model quality.</p> : null}
      <div className="training-dialog-actions"><button className="training-button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="training-button" type="button" disabled={busy || !compatible} onClick={() => void start()}>{busy ? "Starting…" : "Start training"}</button></div>
    </section>
  </div>;
}

function sftRecipe(input: { maxSteps: number; sequenceLength: number; rank: number; model: ModelAsset | null }): SftRecipe {
  if (!input.model?.modelId || !input.model.revision || !input.model.tokenizerRevision || !input.model.chatTemplateHash) return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v2-seed-17-context-512", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: 0.01, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 4, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } };
  return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: input.model.modelId, revision: input.model.revision, tokenizerRevision: input.model.tokenizerRevision, chatTemplateHash: input.model.chatTemplateHash }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: input.sequenceLength }, lora: { rank: input.rank, alpha: input.rank * 2, dropout: 0.05, targetModules: ["q_proj", "v_proj"] }, optimizer: { learningRate: 0.0002, epochs: 1, maxSteps: input.maxSteps, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 4, memoryBytes: 8_000_000_000, wallTimeMs: 900_000 } };
}
function tasksetMethod(taskset: Taskset) { const authored = taskset.metadata.trainingMethod; if (typeof authored === "string" && authored !== "none") return authored; return taskset.readiness?.recommendedMethod && taskset.readiness.recommendedMethod !== "none" ? taskset.readiness.recommendedMethod : "sft"; }
function destinationLabel(destination: string) { const labels: Record<string, string> = { export: "Export only", local_cpu_fixture: "Local CPU", local_cuda: "Local NVIDIA GPU", local_mlx: "Apple Silicon", ssh_gpu: "SSH GPU", prime_hosted: "Prime hosted", fireworks: "Fireworks", openpond_managed: "OpenPond managed" }; return labels[destination] ?? destination.replaceAll("_", " "); }
function formatBytes(value: number | null): string { if (value == null) return "size unknown"; return `${(value / 1024 / 1024).toFixed(0)} MB`; }
