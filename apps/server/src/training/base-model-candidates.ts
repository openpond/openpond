import {
  BaseModelCandidateSchema,
  type BaseModelCandidate,
  type BaseModelExecutionOption,
  type BaseModelPreference,
  type TrainingDestinationCapabilities,
} from "@openpond/contracts";
import { managedRlBaseProfileForModel } from "./managed-rl-base-profile.js";

export function projectBaseModelCandidates(input: {
  destinations: TrainingDestinationCapabilities[];
}): BaseModelCandidate[] {
  const candidates: BaseModelCandidate[] = [];
  const managedModelIds = new Set(
    input.destinations
      .flatMap((destination) => destination.modelAllowlist),
  );

  for (const modelId of managedModelIds) {
    const options = executionOptions(input.destinations, modelId);
    if (!options.length) continue;
    const managedProfile = managedRlBaseProfileForModel(modelId);
    candidates.push(
      candidate({
        preference: {
          schemaVersion: "openpond.baseModelPreference.v1",
          modelId,
          revision: managedProfile?.revision ?? null,
          tokenizerRevision: managedProfile?.tokenizerRevision ?? null,
          chatTemplateHash: managedProfile?.chatTemplateHash ?? null,
          modelAssetId: null,
          source: "managed",
        },
        label: modelLabel(modelId),
        sourceLabel: sourceLabel(options),
        options,
        compatibilityReason: null,
      }),
    );
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
    source: "managed",
  };
}

function executionOptions(
  destinations: TrainingDestinationCapabilities[],
  modelId: string,
): BaseModelExecutionOption[] {
  return destinations
    .filter(
      (destination) =>
        destination.modelAllowlist.includes(modelId),
    )
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
    nonProduction: (availableOptions.length ? availableOptions : input.options).every(
      (option) => option.nonProduction,
    ),
    unavailableReason: available
      ? null
      : [...new Set(reasons)].join(" ") || "No compatible training destination is available.",
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

function destinationLabel(destinationId: BaseModelExecutionOption["destinationId"]): string {
  const labels: Partial<Record<BaseModelExecutionOption["destinationId"], string>> = {
    openpond_managed: "OpenPond Managed",
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
import { createHash } from "node:crypto";
