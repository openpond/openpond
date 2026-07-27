import {
  TrainingCatalogSchema,
  type BaseModelCandidate,
  type ComputeInventory,
  type ComputeTargetBinding,
  type ComputeTargetCapabilities,
  type HarnessRuntimeCapabilities,
  type HarnessRuntimeTargetBinding,
  type ModelRunDraft,
  type TrainingCatalog,
  type TrainingDestinationCapabilities,
  type TrainingEngineBinding,
  type TrainingEngineCapabilities,
  type TrainingPreparationPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { prepareTrainingSelection } from "@openpond/training-sdk";
import type { RegistryModelSearchResult } from "./model-registry-search.js";

const PRIME_RL_REVISION =
  "e0d60e4d85ea636873acb2e7083e794740d20226";
const LOCAL_TARGET_POLICY = {
  executionMode: "local_worker" as const,
  approvalPolicy: null,
  limits: {
    maximumSequenceLength: 4_096,
    maximumOutputTokens: 4_096,
    maximumTrainingExamples: null,
  },
  defaults: {
    loraRank: 2,
    rolloutOutputTokens: 64,
  },
};
const CONNECTED_TARGET_POLICY = {
  executionMode: "connected_worker" as const,
  approvalPolicy: null,
  limits: {
    maximumSequenceLength: 32_768,
    maximumOutputTokens: 8_192,
    maximumTrainingExamples: null,
  },
  defaults: {
    loraRank: 8,
    rolloutOutputTokens: 2_048,
  },
};
const FIREWORKS_TARGET_POLICY = {
  executionMode: "provider_native" as const,
  approvalPolicy: {
    providerId: "fireworks" as const,
    providerLabel: "Fireworks",
    settingsActionLabel: "Manage Fireworks provider",
    exportApprovalRequired: true,
    exportDescription:
      "Export only the approved train split. Frozen Eval cases and grader secrets stay in OpenPond.",
    preparationRequired: true,
    minimumSpendUsd: 3,
    maximumSpendUsd: 9.99,
    defaultMaximumSpendUsd: 3,
    minimumRetentionDays: 1,
    maximumRetentionDays: 30,
    defaultRetentionDays: 7,
    methodRequirement:
      "RFT requires the configured provider callback. Launch fails closed before upload when it is unavailable.",
  },
  limits: {
    maximumSequenceLength: 32_768,
    maximumOutputTokens: 8_192,
    maximumTrainingExamples: 32,
  },
  defaults: {
    loraRank: 8,
    rolloutOutputTokens: 2_048,
  },
};

export function createPortableTrainingCatalog(input: {
  candidates: BaseModelCandidate[];
  destinations: TrainingDestinationCapabilities[];
  inventory: ComputeInventory | null;
  searchResults?: RegistryModelSearchResult[];
  registeredEngineIds?: string[];
  connectedWorkerConfigured?: boolean;
  connectedEngineConfigured?: boolean;
  primeRawConfigured?: boolean;
  connectedWorkerImageDigest?: string | null;
  adapterCompute?: ComputeTargetCapabilities[];
  now?: string;
}): TrainingCatalog {
  const generatedAt = input.now ?? new Date().toISOString();
  const compute = computeCapabilities(
    input.inventory,
    generatedAt,
    input.connectedWorkerConfigured ?? false,
    input.primeRawConfigured ?? false,
    input.adapterCompute ?? [],
  );
  const engines = engineCapabilities({
    destinations: input.destinations,
    generatedAt,
    registeredEngineIds: input.registeredEngineIds ?? [],
    connectedEngineConfigured:
      input.connectedEngineConfigured ?? false,
    primeRawConfigured:
      input.primeRawConfigured ?? false,
    connectedWorkerImageDigest: input.connectedWorkerImageDigest ?? null,
  });
  const runtimes = runtimeCapabilities(generatedAt);
  const targets = trainingTargets({
    compute,
    engines,
    runtimes,
    destinations: input.destinations,
  });
  const models: TrainingCatalog["models"] = input.candidates.map((candidate) => {
    const asset = input.inventory?.models.find(
      (model) => model.id === candidate.preference.modelAssetId,
    );
    const computeAdapterIds = candidate.executionOptions.map((option) =>
      computeIdForDestination(option.destinationId),
    );
    const engineAdapterIds = candidate.executionOptions.map((option) =>
      engineIdForDestination(option.destinationId),
    );
    const cached = Boolean(asset) || candidate.preference.source === "builtin";
    const providerManaged =
      candidate.preference.source === "managed";
    const chatTemplateHash =
      candidate.preference.chatTemplateHash &&
      /^[a-f0-9]{64}$/.test(candidate.preference.chatTemplateHash)
        ? candidate.preference.chatTemplateHash
        : providerManaged
          ? sha256(
              `provider-managed-chat-template:${candidate.preference.modelId}`,
            )
          : null;
    const exactIdentity = Boolean(
      candidate.preference.revision &&
      candidate.preference.tokenizerRevision &&
      chatTemplateHash,
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
      source:
        candidate.preference.source === "local" &&
        asset?.source === "huggingface"
          ? ("huggingface" as const)
          : candidate.preference.source,
      modelId: candidate.preference.modelId,
      revision:
        candidate.preference.revision ??
        (providerManaged ? "provider-managed-model-resource-v1" : null),
      tokenizerRevision:
        candidate.preference.tokenizerRevision ??
        (providerManaged ? "provider-managed-tokenizer-v1" : null),
      chatTemplateHash,
      modelAssetId: candidate.preference.modelAssetId,
      expectedBytes: asset?.sizeBytes ?? null,
      cached,
      known: true,
      searchResolved: false,
      computeAdapterIds: [...new Set(computeAdapterIds)],
      engineAdapterIds: [...new Set(engineAdapterIds)],
      preparationState: candidate.available && exactIdentity
        ? preparationState
        : ("unsupported" as const),
      reason: candidate.available && exactIdentity
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
        const engine = engines.find(
          (item) => item.adapterId === target.engineAdapterId,
        );
        const state = !exactIdentity
          ? ("unsupported" as const)
          : !option
          ? ("unsupported" as const)
          : !target.available
            ? target.computeAdapterId === "prime-raw"
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
                : option?.unavailableReason ??
                "This Model is not supported by the selected training target."
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
}): TrainingCatalog["targets"] {
  const definitions = [
    {
      id: "automatic",
      label: "Automatic (recommended)",
      description: "Use the best available compatible training target.",
      destinationId: "local_cpu_fixture",
      computeAdapterId: "local-cpu",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "local-trl",
      capabilityPills: ["Local"],
      ...LOCAL_TARGET_POLICY,
    },
    {
      id: "this-device-cpu",
      label: "This device · CPU",
      description: "Keep the Harness and reference worker on this device.",
      destinationId: "local_cpu_fixture",
      computeAdapterId: "local-cpu",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "local-trl",
      capabilityPills: ["Local"],
      ...LOCAL_TARGET_POLICY,
    },
    {
      id: "connected-gpu",
      label: "Connected GPU",
      description: "Use the authenticated LAN/SSH/BYOC worker protocol.",
      destinationId: "ssh_gpu",
      computeAdapterId: "ssh-worker",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "connected-prime-rl",
      capabilityPills: ["LAN/SSH GPU"],
      ...CONNECTED_TARGET_POLICY,
    },
    {
      id: "prime-gpu",
      label: "Prime Raw GPU",
      description:
        "Provision raw Prime compute for OpenPond-controlled rollout and PRIME-RL execution. This is not Prime Hosted Training.",
      destinationId: "prime_hosted",
      computeAdapterId: "prime-raw",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "connected-prime-rl",
      capabilityPills: ["Prime Raw GPU"],
      ...CONNECTED_TARGET_POLICY,
    },
    {
      id: "fireworks-managed",
      label: "Fireworks",
      description: "Use provider-managed training after quote and approval.",
      destinationId: "fireworks",
      computeAdapterId: "fireworks-managed",
      runtimeAdapterId: "provider-native",
      engineAdapterId: "fireworks-native",
      capabilityPills: ["Fireworks"],
      ...FIREWORKS_TARGET_POLICY,
    },
  ] as const;
  return definitions.map((definition) => {
    const compute = input.compute.find(
      (item) => item.adapterId === definition.computeAdapterId,
    );
    const engine = input.engines.find(
      (item) => item.adapterId === definition.engineAdapterId,
    );
    const runtime = input.runtimes.find(
      (item) => item.adapterId === definition.runtimeAdapterId,
    );
    const destination = input.destinations.find(
      (item) => item.destinationId === definition.destinationId,
    );
    const available = Boolean(
      compute?.available &&
      engine?.available &&
      runtime?.available &&
      destination?.available,
    );
    return {
      ...definition,
      methods: destination?.methods ?? engine?.methods ?? [],
      capabilityPills: [...definition.capabilityPills],
      available,
      unavailableReason: available
        ? null
        : compute?.unavailableReason ??
          engine?.unavailableReason ??
          runtime?.unavailableReason ??
          destination?.unavailableReason ??
          "This training target is not configured.",
    };
  });
}

export function preparePortableModelRun(input: {
  modelRun: ModelRunDraft;
  catalog: TrainingCatalog;
  maximumSpendUsd?: number | null;
  quoteUsd?: number | null;
  retentionDays?: number | null;
}): TrainingPreparationPlan {
  const model = input.catalog.models.find(
    (candidate) =>
      candidate.modelId === input.modelRun.baseModel?.modelId &&
      candidate.revision === input.modelRun.baseModel?.revision,
  );
  const bindings = resolvePortableBindings({
    modelRun: input.modelRun,
    catalog: input.catalog,
  });
  const engine = bindings.engine
    ? input.catalog.engines.find(
        (candidate) => candidate.adapterId === bindings.engine!.adapterId,
      ) ?? null
    : null;
  const compute = bindings.compute
    ? input.catalog.compute.find(
        (candidate) => candidate.adapterId === bindings.compute!.adapterId,
      ) ?? null
    : null;
  return prepareTrainingSelection({
    modelRunId: input.modelRun.id,
    modelCached: model?.cached ?? false,
    modelBytes: model?.expectedBytes ?? 0,
    engine,
    compute,
    manifest: bindings,
    maximumSpendUsd: input.maximumSpendUsd ?? null,
    quoteUsd: input.quoteUsd ?? null,
    retentionDays: input.retentionDays ?? null,
    providerManaged:
      input.modelRun.destinationId === "fireworks",
  });
}

export function resolvePortableBindings(input: {
  modelRun: ModelRunDraft;
  catalog: TrainingCatalog;
}): {
  runtime: HarnessRuntimeTargetBinding | null;
  compute: ComputeTargetBinding | null;
  engine: TrainingEngineBinding | null;
} {
  const destinationId = input.modelRun.destinationId;
  if (!destinationId) return { runtime: null, compute: null, engine: null };
  const computeId = computeIdForDestination(destinationId);
  const engineId = engineIdForDestination(destinationId);
  const runtimeId =
    destinationId === "fireworks"
      ? "provider-native"
      : "local-harness";
  const compute = input.catalog.compute.find(
    (candidate) => candidate.adapterId === computeId,
  );
  const engine = input.catalog.engines.find(
    (candidate) => candidate.adapterId === engineId,
  );
  const runtime = input.catalog.runtimes.find(
    (candidate) => candidate.adapterId === runtimeId,
  );
  if (!compute || !engine || !runtime) {
    return { runtime: null, compute: null, engine: null };
  }
  return {
    runtime: {
      adapterId: runtime.adapterId,
      placement:
        runtimeId === "provider-native"
          ? "provider_native"
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
  inventory: ComputeInventory | null,
  checkedAt: string,
  connectedWorkerConfigured: boolean,
  primeRawConfigured: boolean,
  adapters: ComputeTargetCapabilities[],
): ComputeTargetCapabilities[] {
  const localDevices: ComputeTargetCapabilities["devices"] =
    inventory?.devices.map((device) => ({
      id: device.id,
      kind: device.kind,
      vendor: device.vendor,
      name: device.name,
      memoryBytes: device.totalMemoryBytes,
      runtime:
        device.vendor === "nvidia"
          ? "cuda"
          : device.vendor === "apple"
            ? "mlx"
            : "cpu",
    })) ?? [
      {
        id: "cpu",
        kind: "cpu",
        vendor: "other",
        name: "Local CPU",
        memoryBytes: null,
        runtime: "cpu",
      },
    ];
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
    supportsWorkerImages: adapterId !== "local-cpu",
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
  const sshAvailable =
    connectedWorkerConfigured ||
    (inventory?.connections.some(
      (connection) =>
        connection.kind === "ssh" && connection.available,
    ) ?? false);
  const defaults = [
    capability("local-cpu", "local", null, localDevices.filter((device) => device.kind === "cpu"), true, null),
    capability("ssh-worker", "ssh", null, [], sshAvailable, sshAvailable ? null : "Configure and verify an SSH worker connection."),
    capability(
      "prime-raw",
      "managed",
      "prime",
      primeRawConfigured
        ? [{
            id: "prime-raw-dynamic",
            kind: "gpu",
            vendor: "nvidia",
            name: "Prime secure H100 (fresh quote)",
            memoryBytes: 80_000_000_000,
            runtime: "cuda",
          }]
        : [],
      primeRawConfigured,
      primeRawConfigured
        ? null
        : "Connect and verify Prime before requesting a fresh raw-GPU quote.",
    ),
    capability("fireworks-managed", "managed", "fireworks", [], true, null),
  ];
  return mergeAdapterCapabilities(defaults, adapters);
}

function engineCapabilities(input: {
  destinations: TrainingDestinationCapabilities[];
  generatedAt: string;
  registeredEngineIds: string[];
  connectedEngineConfigured: boolean;
  primeRawConfigured: boolean;
  connectedWorkerImageDigest: string | null;
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
    workerProtocolVersion: "openpond.connectedWorker.v1",
    upstreamRevision,
    capabilityReceipt: contentHash({
      adapterId,
      methods,
      upstreamRevision,
      available,
    }),
    checkedAt: input.generatedAt,
    unavailableReason: reason,
    workerImageDigest:
      adapterId === "connected-prime-rl"
        ? input.connectedWorkerImageDigest
        : null,
  });
  const fireworksAvailable =
    input.destinations.find(
      (destination) => destination.destinationId === "fireworks",
    )?.available ?? false;
  const registered = new Set(input.registeredEngineIds);
  return [
    engine("local-trl", ["sft", "dpo", "ppo"], ["demonstration", "preference", "trajectory", "reward"], registered.has("local-trl"), "trl-0.26.2", registered.has("local-trl") ? null : "The local TRL adapter is not registered."),
    engine(
      "connected-prime-rl",
      ["grpo"],
      [
        "trajectory",
        "reward",
        "grader_evidence",
        "infrastructure_failure",
      ],
      input.primeRawConfigured ||
        (
          input.connectedEngineConfigured &&
          registered.has("connected-prime-rl") &&
          input.connectedWorkerImageDigest !== null
        ),
      PRIME_RL_REVISION,
      input.primeRawConfigured
        ? null
        : !input.connectedEngineConfigured
          ? "Configure an authenticated connected or managed worker route."
          : input.connectedWorkerImageDigest === null
            ? "Configure an immutable connected-worker image digest."
            : !registered.has("connected-prime-rl")
              ? "Register the connected training engine."
              : null,
    ),
    engine("fireworks-native", ["sft", "grpo"], ["demonstration", "trajectory", "reward"], fireworksAvailable && registered.has("fireworks-native"), "provider-managed", !fireworksAvailable ? "Fireworks is not configured." : !registered.has("fireworks-native") ? "The Fireworks adapter is not registered." : null),
  ];
}

function runtimeCapabilities(
  checkedAt: string,
): HarnessRuntimeCapabilities[] {
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
  ];
}

function mergeAdapterCapabilities<T extends { adapterId: string }>(
  defaults: T[],
  adapters: T[],
): T[] {
  const resolved = new Map(
    defaults.map((capability) => [capability.adapterId, capability]),
  );
  for (const capability of adapters) {
    resolved.set(capability.adapterId, capability);
  }
  return [...resolved.values()];
}

function computeIdForDestination(destinationId: string): string {
  const values: Record<string, string> = {
    local_cpu_fixture: "local-cpu",
    ssh_gpu: "ssh-worker",
    prime_hosted: "prime-raw",
    fireworks: "fireworks-managed",
  };
  return values[destinationId] ?? "unsupported";
}

function engineIdForDestination(destinationId: string): string {
  const values: Record<string, string> = {
    local_cpu_fixture: "local-trl",
    ssh_gpu: "connected-prime-rl",
    prime_hosted: "connected-prime-rl",
    fireworks: "fireworks-native",
  };
  return values[destinationId] ?? "unsupported";
}
