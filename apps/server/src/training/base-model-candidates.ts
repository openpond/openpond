import { createHash } from "node:crypto";

import {
  BaseModelCandidateSchema,
  type BaseModelCandidate,
  type BaseModelExecutionOption,
  type BaseModelPreference,
  type ComputeInventory,
  type ModelAsset,
  type TrainingDestinationCapabilities,
} from "@openpond/contracts";

const LOCAL_DESTINATIONS = new Set(["local_cpu_fixture", "local_cuda", "local_mlx"]);
const TINY_CPU_MODEL = "openpond/tiny-cpu-gpt2-fixture";

export function projectBaseModelCandidates(input: {
  destinations: TrainingDestinationCapabilities[];
  inventory: ComputeInventory | null;
}): BaseModelCandidate[] {
  const candidates: BaseModelCandidate[] = [];
  const managedModelIds = new Set(
    input.destinations
      .filter((destination) => !LOCAL_DESTINATIONS.has(destination.destinationId))
      .flatMap((destination) => destination.modelAllowlist),
  );

  for (const modelId of managedModelIds) {
    const options = executionOptions(input.destinations, modelId, false);
    if (!options.length) continue;
    candidates.push(candidate({
      preference: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId,
        revision: null,
        tokenizerRevision: null,
        chatTemplateHash: null,
        modelAssetId: null,
        source: "managed",
      },
      label: modelLabel(modelId),
      sourceLabel: sourceLabel(options),
      options,
      compatibilityReason: null,
    }));
  }

  const builtinOptions = executionOptions(input.destinations, TINY_CPU_MODEL, true);
  if (builtinOptions.length) {
    candidates.push(candidate({
      preference: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: TINY_CPU_MODEL,
        revision: "architecture-v2-seed-17-context-512",
        tokenizerRevision: "wordlevel-v1",
        chatTemplateHash: "fixture00000000",
        modelAssetId: null,
        source: "builtin",
      },
      label: "Tiny CPU correctness fixture",
      sourceLabel: "This machine",
      options: builtinOptions,
      compatibilityReason: null,
    }));
  }

  const localByLineage = new Map<string, ModelAsset>();
  for (const model of input.inventory?.models ?? []) {
    if (
      !model.trainingCompatible
      || !model.modelId
      || !model.revision
      || !model.tokenizerRevision
      || !model.chatTemplateHash
    ) continue;
    const lineage = [
      model.modelId,
      model.revision,
      model.tokenizerRevision,
      model.chatTemplateHash,
    ].join("\n");
    if (!localByLineage.has(lineage)) localByLineage.set(lineage, model);
  }

  for (const model of localByLineage.values()) {
    const options = executionOptions(input.destinations, model.modelId!, true);
    if (!options.length) continue;
    candidates.push(candidate({
      preference: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: model.modelId!,
        revision: model.revision!,
        tokenizerRevision: model.tokenizerRevision!,
        chatTemplateHash: model.chatTemplateHash!,
        modelAssetId: model.id,
        source: "local",
      },
      label: model.name,
      sourceLabel: localSourceLabel(model),
      options,
      compatibilityReason: model.compatibilityReason,
    }));
  }

  return candidates.sort(compareCandidates);
}

export function legacyBaseModelPreference(modelId: string): BaseModelPreference {
  return {
    schemaVersion: "openpond.baseModelPreference.v1",
    modelId,
    revision: null,
    tokenizerRevision: null,
    chatTemplateHash: null,
    modelAssetId: null,
    source: modelId === TINY_CPU_MODEL ? "builtin" : "managed",
  };
}

function executionOptions(
  destinations: TrainingDestinationCapabilities[],
  modelId: string,
  local: boolean,
): BaseModelExecutionOption[] {
  return destinations
    .filter((destination) =>
      LOCAL_DESTINATIONS.has(destination.destinationId) === local
      && destination.modelAllowlist.includes(modelId))
    .map((destination) => ({
      destinationId: destination.destinationId,
      available: destination.available,
      methods: destination.methods,
      parameterizations: destination.parameterizations,
      nonProduction: destination.nonProduction,
      unavailableReason: destination.unavailableReason,
    }));
}

function candidate(input: {
  preference: BaseModelPreference;
  label: string;
  sourceLabel: string;
  options: BaseModelExecutionOption[];
  compatibilityReason: string | null;
}): BaseModelCandidate {
  const availableOptions = input.options.filter((option) => option.available);
  const available = availableOptions.length > 0;
  const reasons = [
    input.compatibilityReason,
    ...input.options.map((option) => option.unavailableReason),
  ].filter((reason): reason is string => Boolean(reason));
  return BaseModelCandidateSchema.parse({
    schemaVersion: "openpond.baseModelCandidate.v1",
    selectionKey: `base_model_${createHash("sha256")
      .update(JSON.stringify(input.preference))
      .digest("hex")
      .slice(0, 24)}`,
    label: input.label,
    sourceLabel: input.sourceLabel,
    preference: input.preference,
    available,
    nonProduction: (availableOptions.length ? availableOptions : input.options)
      .every((option) => option.nonProduction),
    unavailableReason: available ? null : [...new Set(reasons)].join(" ") || "No compatible training destination is available.",
    methods: [...new Set(input.options.flatMap((option) => option.methods))],
    executionOptions: input.options,
  });
}

function compareCandidates(left: BaseModelCandidate, right: BaseModelCandidate): number {
  const rank = (candidate: BaseModelCandidate) => {
    if (candidate.preference.source === "managed" && candidate.available) return 0;
    if (candidate.preference.source === "local" && candidate.available) return 1;
    if (candidate.preference.source === "builtin" && candidate.available) return 2;
    return 3;
  };
  return rank(left) - rank(right) || left.label.localeCompare(right.label);
}

function sourceLabel(options: BaseModelExecutionOption[]): string {
  const labels = [...new Set(options.map((option) => destinationLabel(option.destinationId)))];
  return labels.length === 1 ? labels[0]! : "Managed";
}

function localSourceLabel(model: ModelAsset): string {
  if (model.source === "huggingface") return "Hugging Face · This machine";
  if (model.source === "mlx") return "MLX · This machine";
  return "This machine";
}

function destinationLabel(destinationId: BaseModelExecutionOption["destinationId"]): string {
  const labels: Partial<Record<BaseModelExecutionOption["destinationId"], string>> = {
    fireworks: "Fireworks",
    prime_hosted: "Prime hosted",
    openpond_managed: "OpenPond managed",
    local_cpu_fixture: "Local CPU",
    local_cuda: "Local NVIDIA GPU",
    local_mlx: "Apple Silicon",
  };
  return labels[destinationId] ?? destinationId.replaceAll("_", " ");
}

function modelLabel(modelId: string): string {
  const name = modelId.split("/").filter(Boolean).at(-1) ?? modelId;
  return name
    .replace(/(\d+)p(\d+)b/gi, "$1.$2B")
    .replace(/(\d+)b/gi, "$1B")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}
