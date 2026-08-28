import {
  TrainingCatalogSchema,
  type BaseModelCandidate,
  type ComputeTargetBinding,
  type ComputeTargetCapabilities,
  type HarnessRuntimeCapabilities,
  type HarnessRuntimeTargetBinding,
  type ModelProject,
  type TrainingCatalog,
  type TrainingDestinationCapabilities,
  type TrainingEngineBinding,
  type TrainingEngineCapabilities,
  type TrainingPreparationPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { prepareTrainingSelection } from "@openpond/training-sdk";
import type { RegistryModelSearchResult } from "./model-registry-search.js";

const MANAGED_RL_REVISION = "e0d60e4d85ea636873acb2e7083e794740d20226";
const MANAGED_TARGET_POLICY = {
  executionMode: "provider_native" as const,
  approvalPolicy: {
    providerId: "openpond" as const,
    providerLabel: "OpenPond Managed",
    settingsActionLabel: "Manage OpenPond account",
    exportApprovalRequired: true,
    exportDescription:
      "Submit the approved trainer projection and private validation tasks to OpenPond Managed.",
    preparationRequired: true,
    minimumSpendUsd: 1,
    maximumSpendUsd: 25,
    defaultMaximumSpendUsd: 9,
    minimumRetentionDays: 1,
    maximumRetentionDays: 30,
    defaultRetentionDays: 7,
    methodRequirement: "Managed training selects qualified compute capacity after approval.",
  },
  limits: {
    maximumSequenceLength: 4_096,
    maximumOutputTokens: 8_192,
    maximumTrainingExamples: null,
  },
  defaults: {
    loraRank: 16,
    maxSteps: 2,
    rolloutGroupSize: 4,
    rolloutConcurrency: 4,
    rolloutOutputTokens: 512,
  },
};
export function createPortableTrainingCatalog(input: {
  candidates: BaseModelCandidate[];
  destinations: TrainingDestinationCapabilities[];
  searchResults?: RegistryModelSearchResult[];
  registeredEngineIds?: string[];
  adapterCompute?: ComputeTargetCapabilities[];
  preferredMethod?: "sft" | "dpo" | "grpo" | "ppo";
  now?: string;
}): TrainingCatalog {
  const generatedAt = input.now ?? new Date().toISOString();
  const compute = computeCapabilities(generatedAt, input.adapterCompute ?? []);
  const engines = engineCapabilities({
    destinations: input.destinations,
    generatedAt,
    registeredEngineIds: input.registeredEngineIds ?? [],
  });
  const runtimes = runtimeCapabilities(generatedAt);
  const targets = trainingTargets({
    compute,
    engines,
    runtimes,
    destinations: input.destinations,
    preferredMethod: input.preferredMethod,
  });
  const models: TrainingCatalog["models"] = input.candidates.map((candidate) => {
    const computeAdapterIds = candidate.executionOptions.map((option) =>
      computeIdForDestination(option.destinationId),
    );
    const engineAdapterIds = candidate.executionOptions.map((option) =>
      engineIdForDestination(option.destinationId),
    );
    const cached = false;
    const providerManaged = candidate.preference.source === "managed";
    const chatTemplateHash =
      candidate.preference.chatTemplateHash &&
      /^[a-f0-9]{64}$/.test(candidate.preference.chatTemplateHash)
        ? candidate.preference.chatTemplateHash
        : providerManaged
          ? sha256(`provider-managed-chat-template:${candidate.preference.modelId}`)
          : null;
    const exactIdentity =
      Boolean(
        candidate.preference.revision && candidate.preference.tokenizerRevision && chatTemplateHash,
      ) || providerManaged;
    const preparationState =
      candidate.preference.source === "managed"
        ? ("provider_managed" as const)
        : cached
          ? ("ready" as const)
          : ("model_download_required" as const);
    return {
      selectionKey: candidate.selectionKey,
      label: candidate.label,
      source: candidate.preference.source,
      modelId: candidate.preference.modelId,
      revision:
        candidate.preference.revision ??
        (providerManaged ? "provider-managed-model-resource-v1" : null),
      tokenizerRevision:
        candidate.preference.tokenizerRevision ??
        (providerManaged ? "provider-managed-tokenizer-v1" : null),
      chatTemplateHash,
      modelAssetId: candidate.preference.modelAssetId,
      expectedBytes: null,
      cached,
      known: true,
      searchResolved: false,
      computeAdapterIds: [...new Set(computeAdapterIds)],
      engineAdapterIds: [...new Set(engineAdapterIds)],
      preparationState:
        candidate.available && exactIdentity ? preparationState : ("unsupported" as const),
      reason:
        candidate.available && exactIdentity
          ? preparationState === "model_download_required"
            ? "Pinned Model weights must be downloaded during Run preparation."
            : preparationState === "provider_managed"
              ? "The provider prepares these weights after approval."
              : null
          : candidate.available
            ? "This Model is missing an exact revision, tokenizer revision, or canonical chat-template hash."
            : candidate.unavailableReason,
      compatibilities: targets.map((target) => {
        const option = candidate.executionOptions.find(
          (item) => item.destinationId === target.destinationId,
        );
        const methods = option?.methods ?? [];
        const engine = engines.find((item) => item.adapterId === target.engineAdapterId);
        const state = !exactIdentity
          ? ("unsupported" as const)
          : !option
            ? ("unsupported" as const)
            : !target.available
              ? target.computeAdapterId === "openpond-managed"
                ? ("compute_setup_required" as const)
                : engine && !engine.available
                  ? ("unsupported" as const)
                  : ("compute_setup_required" as const)
              : !option.available
                ? ("unsupported" as const)
                : preparationState;
        return {
          targetId: target.id,
          methods,
          state,
          reason:
            state === "unsupported"
              ? !exactIdentity
                ? "Import or rescan this Model to record its exact revision, tokenizer revision, and canonical chat-template hash."
                : (option?.unavailableReason ??
                  "This Model is not supported by the selected training target.")
              : state === "compute_setup_required"
                ? target.unavailableReason
                : state === "model_download_required"
                  ? "Pinned Model weights will be downloaded after Run review."
                  : state === "provider_managed"
                    ? "The provider manages Model preparation after approval."
                    : null,
        };
      }),
    };
  });
  const knownModelIds = new Set(models.map((model) => model.modelId));
  for (const result of input.searchResults ?? []) {
    if (knownModelIds.has(result.modelId)) continue;
    const reason = result.revision
      ? "Registry search resolved an exact repository revision, but tokenizer and chat-template compatibility must be imported and verified before training."
      : "Registry search found this Model, but it has no exact revision and cannot enter a released run.";
    models.push({
      selectionKey: `registry_model_${sha256(result.modelId).slice(0, 24)}`,
      label: result.label,
      source: "search",
      modelId: result.modelId,
      revision: result.revision,
      tokenizerRevision: null,
      chatTemplateHash: null,
      modelAssetId: null,
      expectedBytes: null,
      cached: false,
      known: false,
      searchResolved: true,
      computeAdapterIds: [],
      engineAdapterIds: [],
      preparationState: "unsupported",
      reason,
      compatibilities: targets.map((target) => ({
        targetId: target.id,
        methods: target.methods,
        state: "unsupported" as const,
        reason,
      })),
    });
  }
  const base = {
    schemaVersion: "openpond.trainingCatalog.v1" as const,
    models,
    engines,
    compute,
    runtimes,
    targets,
    generatedAt,
  };
  return TrainingCatalogSchema.parse({
    ...base,
    contentHash: contentHash(base),
  });
}

function trainingTargets(input: {
  compute: ComputeTargetCapabilities[];
  engines: TrainingEngineCapabilities[];
  runtimes: HarnessRuntimeCapabilities[];
  destinations: TrainingDestinationCapabilities[];
  preferredMethod?: "sft" | "dpo" | "grpo" | "ppo";
}): TrainingCatalog["targets"] {
  const definitions = [
    {
      id: "openpond-managed",
      label: "OpenPond Managed",
      description: "Run the approved portable training bundle on OpenPond-managed infrastructure.",
      destinationId: "openpond_managed",
      computeAdapterId: "openpond-managed",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "sandbox-managed-rl",
      capabilityPills: ["Managed", "Desktop rollouts"],
      ...MANAGED_TARGET_POLICY,
    },
  ] as const;
  const resolved = definitions.map((definition) => {
    const compute = input.compute.find((item) => item.adapterId === definition.computeAdapterId);
    const engine = input.engines.find((item) => item.adapterId === definition.engineAdapterId);
    const runtime = input.runtimes.find((item) => item.adapterId === definition.runtimeAdapterId);
    const destination = input.destinations.find(
      (item) => item.destinationId === definition.destinationId,
    );
    const available = Boolean(
      compute?.available && engine?.available && runtime?.available && destination?.available,
    );
    return {
      ...definition,
      methods: destination?.methods ?? engine?.methods ?? [],
      capabilityPills: [...definition.capabilityPills],
      available,
      unavailableReason: available
        ? null
        : (compute?.unavailableReason ??
          engine?.unavailableReason ??
          runtime?.unavailableReason ??
          destination?.unavailableReason ??
          "This training target is not configured."),
    };
  });
  const selected =
    resolved.find(
      (target) =>
        target.available &&
        (!input.preferredMethod || target.methods.includes(input.preferredMethod)),
    ) ??
    resolved.find(
      (target) => !input.preferredMethod || target.methods.includes(input.preferredMethod),
    ) ??
    resolved[0]!;
  return [
    {
      ...selected,
      id: "automatic",
      label: "Automatic",
      description: selected.available
        ? `Backend selected ${selected.label}. ${selected.description}`
        : "No compatible training provider is currently available.",
      capabilityPills: ["Backend selected"],
    },
  ];
}

export function preparePortableModelRun(input: {
  modelProject: ModelProject;
  modelRunId?: string;
  catalog: TrainingCatalog;
  maximumSpendUsd?: number | null;
  quoteUsd?: number | null;
  retentionDays?: number | null;
}): TrainingPreparationPlan {
  const model = input.catalog.models.find(
    (candidate) =>
      candidate.modelId === input.modelProject.trainingSetup.baseModel?.modelId &&
      candidate.revision === input.modelProject.trainingSetup.baseModel?.revision,
  );
  const bindings = resolvePortableBindings({
    modelProject: input.modelProject,
    catalog: input.catalog,
  });
  const engine = bindings.engine
    ? (input.catalog.engines.find(
        (candidate) => candidate.adapterId === bindings.engine!.adapterId,
      ) ?? null)
    : null;
  const compute = bindings.compute
    ? (input.catalog.compute.find(
        (candidate) => candidate.adapterId === bindings.compute!.adapterId,
      ) ?? null)
    : null;
  return prepareTrainingSelection({
    modelRunId: input.modelRunId ?? input.modelProject.id,
    modelCached: model?.cached ?? false,
    modelBytes: model?.expectedBytes ?? 0,
    engine,
    compute,
    manifest: bindings,
    maximumSpendUsd: input.maximumSpendUsd ?? null,
    quoteUsd: input.quoteUsd ?? null,
    retentionDays: input.retentionDays ?? null,
    providerManaged:
      input.modelProject.trainingSetup.destinationId === "openpond_managed",
  });
}

export function resolvePortableBindings(input: {
  modelProject: ModelProject;
  catalog: TrainingCatalog;
  environmentPlacement?: "local" | "remote" | "provider_native" | "colocated" | "none";
}): {
  runtime: HarnessRuntimeTargetBinding | null;
  compute: ComputeTargetBinding | null;
  engine: TrainingEngineBinding | null;
} {
  const setup = input.modelProject.trainingSetup;
  const destinationId = setup.destinationId;
  if (!destinationId) return { runtime: null, compute: null, engine: null };
  const computeId = computeIdForDestination(destinationId);
  const engineId = engineIdForDestination(destinationId);
  const runtimeId = destinationId === "openpond_managed"
    ? input.environmentPlacement === "remote" ||
      (input.environmentPlacement === undefined &&
        setup.managedRolloutPlacement === "remote")
      ? "openpond-managed-harness"
      : "local-harness"
    : "local-harness";
  const compute = input.catalog.compute.find((candidate) => candidate.adapterId === computeId);
  const engine = input.catalog.engines.find((candidate) => candidate.adapterId === engineId);
  const runtime = input.catalog.runtimes.find((candidate) => candidate.adapterId === runtimeId);
  if (!compute || !engine || !runtime) {
    return { runtime: null, compute: null, engine: null };
  }
  return {
    runtime: {
      adapterId: runtime.adapterId,
      placement:
        runtimeId === "openpond-managed-harness"
            ? "remote"
            : "local",
      capabilityReceipt: runtime.capabilityReceipt,
      runtimeVersion: "1",
      dataPlane: null,
    },
    compute: {
      adapterId: compute.adapterId,
      kind: compute.kind,
      deviceOrPool: compute.devices[0]?.id ?? compute.adapterId,
      capabilityReceipt: compute.capabilityReceipt,
      provider: compute.provider,
    },
    engine: {
      adapterId: engine.adapterId,
      workerVersion: input.catalog.contentHash.slice(0, 16),
      workerImageDigest: engine.workerImageDigest,
      upstreamRevision: engine.upstreamRevision,
      capabilityReceipt: engine.capabilityReceipt,
    },
  };
}

function computeCapabilities(
  checkedAt: string,
  adapters: ComputeTargetCapabilities[],
): ComputeTargetCapabilities[] {
  const capability = (
    adapterId: string,
    kind: ComputeTargetCapabilities["kind"],
    provider: string | null,
    devices: ComputeTargetCapabilities["devices"],
    available: boolean,
    reason: string | null,
  ): ComputeTargetCapabilities => ({
    schemaVersion: "openpond.computeTargetCapabilities.v1",
    adapterId,
    kind,
    provider,
    available,
    devices,
    supportsWorkerImages: true,
    supportsArtifactTransfer: true,
    supportsCancellation: true,
    capabilityReceipt: contentHash({
      adapterId,
      provider,
      devices,
      available,
    }),
    checkedAt,
    unavailableReason: reason,
  });
  const defaults = [
    capability("openpond-managed", "managed", "openpond", [], true, null),
  ];
  return mergeAdapterCapabilities(defaults, adapters);
}

function engineCapabilities(input: {
  destinations: TrainingDestinationCapabilities[];
  generatedAt: string;
  registeredEngineIds: string[];
}): TrainingEngineCapabilities[] {
  const engine = (
    adapterId: string,
    methods: string[],
    signalKinds: TrainingEngineCapabilities["signalKinds"],
    available: boolean,
    upstreamRevision: string,
    reason: string | null,
  ): TrainingEngineCapabilities => ({
    schemaVersion: "openpond.trainingEngineCapabilities.v1",
    adapterId,
    available,
    methods,
    signalKinds,
    modelFamilies: ["transformers"],
    precisions: ["fp32", "fp16", "bf16"],
    topologies: ["single_worker", "single_gpu_phased"],
    workerProtocolVersion: "openpond.managedRlWorker.v2",
    upstreamRevision,
    capabilityReceipt: contentHash({
      adapterId,
      methods,
      upstreamRevision,
      available,
    }),
    checkedAt: input.generatedAt,
    unavailableReason: reason,
    workerImageDigest: null,
  });
  const registered = new Set(input.registeredEngineIds);
  return [
    engine(
      "sandbox-managed-rl",
      ["grpo"],
      ["trajectory", "reward", "grader_evidence", "infrastructure_failure"],
      registered.has("sandbox-managed-rl"),
      MANAGED_RL_REVISION,
      registered.has("sandbox-managed-rl")
        ? null
        : "Register the OpenPond Managed training adapter.",
    ),
  ];
}

function runtimeCapabilities(checkedAt: string): HarnessRuntimeCapabilities[] {
  const runtime = (
    adapterId: string,
    placements: HarnessRuntimeCapabilities["placements"],
    privilegedIsolation: boolean,
  ): HarnessRuntimeCapabilities => ({
    schemaVersion: "openpond.harnessRuntimeCapabilities.v1",
    adapterId,
    available: true,
    placements,
    lifecycle: ["create", "reset", "step", "grade", "collect", "destroy"],
    deterministicReplay: true,
    privilegedIsolation,
    capabilityReceipt: contentHash({
      adapterId,
      placements,
      privilegedIsolation,
    }),
    checkedAt,
    unavailableReason: null,
  });
  return [
    runtime("local-harness", ["local"], true),
    runtime("provider-native", ["provider_native"], false),
    runtime("openpond-managed-harness", ["remote"], true),
  ];
}

function mergeAdapterCapabilities<T extends { adapterId: string }>(
  defaults: T[],
  adapters: T[],
): T[] {
  const resolved = new Map(defaults.map((capability) => [capability.adapterId, capability]));
  for (const capability of adapters) {
    resolved.set(capability.adapterId, capability);
  }
  return [...resolved.values()];
}

function computeIdForDestination(destinationId: string): string {
  const values: Record<string, string> = {
    openpond_managed: "openpond-managed",
  };
  return values[destinationId] ?? "unsupported";
}

function engineIdForDestination(destinationId: string): string {
  const values: Record<string, string> = {
    openpond_managed: "sandbox-managed-rl",
  };
  return values[destinationId] ?? "unsupported";
}
