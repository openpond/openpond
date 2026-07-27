import type {
  BaseModelCandidate,
  BaseModelPreference,
  RftLossMethod,
  Taskset,
  TrainingDestinationId,
} from "@openpond/contracts";

export type PortableTrainingMethod = "sft" | "dpo" | "grpo" | "ppo";

export function rftLossLabel(method: RftLossMethod): string {
  return method === "gspo-token" ? "GSPO-token" : method.toUpperCase();
}

export function defaultLearningRate(modelId: string): number {
  return modelId === "openpond/tiny-cpu-gpt2-fixture" ? 0.01 : 0.0002;
}

export function tasksetMethod(taskset: Taskset) {
  const authored = taskset.metadata.trainingMethod;
  if (typeof authored === "string" && authored !== "none") return authored;
  const recommended = taskset.readiness?.recommendedMethod;
  return recommended && recommended !== "none" ? recommended : "sft";
}

export function selectableMethods(taskset: Taskset): PortableTrainingMethod[] {
  const methods = new Set<PortableTrainingMethod>();
  for (const method of taskset.capabilities.compatibleMethods) {
    if (
      method === "sft" ||
      method === "dpo" ||
      method === "grpo" ||
      method === "ppo"
    ) {
      methods.add(method);
    }
  }
  if (taskset.readiness?.trainingPath?.bootstrap?.method === "sft") {
    methods.add("sft");
  }
  if (taskset.readiness?.trainingPath?.primaryMethod === "grpo") {
    methods.add("grpo");
  }
  if (taskset.readiness?.trainingPath?.primaryMethod === "ppo") {
    methods.add("ppo");
  }
  return (["sft", "dpo", "grpo", "ppo"] as const).filter((method) =>
    methods.has(method),
  ).length > 0
    ? (["sft", "dpo", "grpo", "ppo"] as const).filter((method) =>
        methods.has(method),
      )
    : ["sft"];
}

export function trainingSplitCount(
  taskset: Taskset,
  split: "train" | "frozen_eval",
): number {
  return (
    taskset.datasetArtifact?.splitCounts[split] ??
    taskset.tasks.filter((task) => task.split === split).length
  );
}

export function destinationLabel(destination: string): string {
  return destination
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

export function candidateForPreference(
  candidates: BaseModelCandidate[],
  preference: BaseModelPreference | null,
): BaseModelCandidate | null {
  if (!preference) return null;
  return (
    candidates.find(
      (candidate) =>
        candidate.preference.modelId === preference.modelId &&
        candidate.preference.source === preference.source &&
        candidate.preference.revision === preference.revision &&
        candidate.preference.modelAssetId === preference.modelAssetId,
    ) ??
    candidates.find(
      (candidate) => candidate.preference.modelId === preference.modelId,
    ) ??
    null
  );
}

export function defaultCandidateForDestination(
  candidates: BaseModelCandidate[],
  destinationId: TrainingDestinationId,
  method: PortableTrainingMethod,
): BaseModelCandidate | null {
  return (
    candidates.find((candidate) =>
      candidate.executionOptions.some(
        (option) =>
          option.destinationId === destinationId &&
          option.available &&
          option.methods.includes(method),
      ),
    ) ?? null
  );
}

export function modelLabel(modelId: string): string {
  const name = modelId.split("/").at(-1) ?? modelId;
  return name
    .replaceAll("-", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

export function preparationStateLabel(state: string): string {
  const labels: Record<string, string> = {
    ready: "Ready",
    model_download_required: "Model download required",
    compute_setup_required: "Compute setup required",
    provider_managed: "Provider managed",
    unsupported: "Unsupported",
  };
  return labels[state] ?? "Unsupported";
}

export function formatBytes(value: number | null): string {
  if (value == null) return "size unknown";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_024 / 1_024).toFixed(0)} MB`;
}
