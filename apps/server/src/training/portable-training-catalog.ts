import {
  TrainingCatalogSchema,
  type BaseModelCandidate,
  type ComputeInventory,
  type ComputeTargetBinding,
  type ComputeTargetCapabilities,
  type HarnessRuntimeCapabilities,
  type HarnessRuntimeTargetBinding,
  type ModelRunDraft,
  type SignedWorkerCatalog,
  type TrainingCatalog,
  type TrainingDestinationCapabilities,
  type TrainingEngineBinding,
  type TrainingEngineCapabilities,
  type TrainingPreparationPlan,
  type WorkerCatalogEntry,
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
  workerCatalog: SignedWorkerCatalog | null;
  searchResults?: RegistryModelSearchResult[];
  registeredEngineIds?: string[];
  connectedWorkerConfigured?: boolean;
  connectedEngineConfigured?: boolean;
  primeRawConfigured?: boolean;
  sandboxManagedConfigured?: boolean;
  connectedWorkerImageDigest?: string | null;
  adapterCompute?: ComputeTargetCapabilities[];
  adapterRuntimes?: HarnessRuntimeCapabilities[];
  now?: string;
}): TrainingCatalog {
  const generatedAt = input.now ?? new Date().toISOString();
  const workers = input.workerCatalog?.entries ?? [];
  const compute = computeCapabilities(
    input.inventory,
    generatedAt,
    input.connectedWorkerConfigured ?? false,
    input.sandboxManagedConfigured ?? false,
    input.primeRawConfigured ?? false,
    input.adapterCompute ?? [],
  );
  const engines = engineCapabilities({
    destinations: input.destinations,
    workers,
    generatedAt,
    registeredEngineIds: input.registeredEngineIds ?? [],
    connectedEngineConfigured:
      input.connectedEngineConfigured ?? false,
    primeRawConfigured:
      input.primeRawConfigured ?? false,
    connectedWorkerImageDigest: input.connectedWorkerImageDigest ?? null,
  });
  const runtimes = runtimeCapabilities(
    generatedAt,
    input.adapterRuntimes ?? [],
  );
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
            ? target.computeAdapterId === "prime-raw" ||
              target.computeAdapterId === "sandbox-connected-gpu"
              ? ("compute_setup_required" as const)
              : engine && !engine.available &&
                  target.engineAdapterId === "connected-prime-rl"
                ? ("worker_download_required" as const)
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
              : state === "worker_download_required"
                ? engine?.unavailableReason ??
                  "A verified worker must be downloaded during Run preparation."
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
    workers,
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
      id: "this-device-cuda",
      label: "This device · CUDA",
      description: "Use a qualified NVIDIA GPU on this device.",
      destinationId: "local_cuda",
      computeAdapterId: "local-cuda",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "connected-prime-rl",
      capabilityPills: ["Local", "CUDA"],
      ...CONNECTED_TARGET_POLICY,
    },
    {
      id: "this-device-mlx",
      label: "This device · MLX",
      description: "Use a qualified Apple accelerator on this device.",
      destinationId: "local_mlx",
      computeAdapterId: "local-mlx",
      runtimeAdapterId: "local-harness",
      engineAdapterId: "local-mlx",
      capabilityPills: ["Local", "MLX"],
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
      id: "sandbox-managed",
      label: "OpenPond Managed",
      description: "Let OpenPond prepare and operate the compute for this training run.",
      destinationId: "openpond_managed",
      computeAdapterId: "sandbox-connected-gpu",
      runtimeAdapterId: "sandbox-latitude",
      engineAdapterId: "connected-prime-rl",
      capabilityPills: ["Managed"],
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
  workerCached?: boolean;
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
  const worker = bindings.engine
    ? input.catalog.workers.find(
        (candidate) =>
          candidate.engineAdapterId === bindings.engine!.adapterId,
      ) ?? null
    : null;
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
    workerCached: input.workerCached ?? false,
    worker,
    engine,
    compute,
    manifest: bindings,
    maximumSpendUsd: input.maximumSpendUsd ?? null,
    quoteUsd: input.quoteUsd ?? null,
    retentionDays: input.retentionDays ?? null,
    providerManaged:
      input.modelRun.destinationId === "fireworks",
    workerRequired:
      bindings.engine?.adapterId !== "local-trl" &&
      bindings.engine?.adapterId !== "local-mlx" &&
      input.modelRun.destinationId !== "fireworks",
  });
}

export function resolvePortableBindings(input: {
  modelRun: ModelRunDraft;
  catalog: TrainingCatalog;
  sandboxBinding?: {
    runtime: HarnessRuntimeTargetBinding;
    compute: ComputeTargetBinding;
  } | null;
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
    destinationId === "openpond_managed"
      ? "sandbox-latitude"
      : destinationId === "fireworks"
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
  const worker = input.catalog.workers.find(
    (candidate) => candidate.engineAdapterId === engineId,
  );
  const dataPlane =
    runtimeId === "sandbox-latitude"
      ? latitudeDataPlaneReceipt()
      : null;
  return {
    runtime:
      destinationId === "openpond_managed" &&
      input.sandboxBinding
        ? input.sandboxBinding.runtime
        : {
      adapterId: runtime.adapterId,
      placement:
        runtimeId === "provider-native"
          ? "provider_native"
          : runtimeId === "sandbox-latitude"
            ? "remote"
            : "local",
      capabilityReceipt: runtime.capabilityReceipt,
      runtimeVersion: "1",
      dataPlane,
    },
    compute:
      destinationId === "openpond_managed" &&
      input.sandboxBinding
        ? input.sandboxBinding.compute
        : {
      adapterId: compute.adapterId,
      kind: compute.kind,
      deviceOrPool: compute.devices[0]?.id ?? compute.adapterId,
      capabilityReceipt: compute.capabilityReceipt,
      provider: compute.provider,
    },
    engine: {
      adapterId: engine.adapterId,
      workerVersion: input.catalog.contentHash.slice(0, 16),
      workerImageDigest: worker?.image.digest ?? null,
      upstreamRevision: engine.upstreamRevision,
      capabilityReceipt: engine.capabilityReceipt,
    },
  };
}

function computeCapabilities(
  inventory: ComputeInventory | null,
  checkedAt: string,
  connectedWorkerConfigured: boolean,
  sandboxManagedConfigured: boolean,
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
  const nvidia = localDevices.filter((device) => device.vendor === "nvidia");
  const apple = localDevices.filter((device) => device.vendor === "apple");
  const sshAvailable =
    connectedWorkerConfigured ||
    (inventory?.connections.some(
      (connection) =>
        connection.kind === "ssh" && connection.available,
    ) ?? false);
  const defaults = [
    capability("local-cpu", "local", null, localDevices.filter((device) => device.kind === "cpu"), true, null),
    capability("local-cuda", "local", null, nvidia, nvidia.length > 0, nvidia.length ? null : "No compatible NVIDIA GPU is available."),
    capability("local-mlx", "local", null, apple, apple.length > 0, apple.length ? null : "No compatible Apple accelerator is available."),
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
    capability(
      "sandbox-connected-gpu",
      "managed",
      "sandbox",
      [],
      sandboxManagedConfigured,
      sandboxManagedConfigured
        ? null
        : "OpenPond Managed is not available for this account.",
    ),
    capability("fireworks-managed", "managed", "fireworks", [], true, null),
  ];
  return mergeAdapterCapabilities(defaults, adapters);
}

function engineCapabilities(input: {
  destinations: TrainingDestinationCapabilities[];
  workers: WorkerCatalogEntry[];
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
  });
  const primeWorker = input.workers.find(
    (candidate) =>
      candidate.engineAdapterId === "connected-prime-rl",
  );
  const workerDigestMatches =
    primeWorker !== undefined &&
    input.connectedWorkerImageDigest !== null &&
    primeWorker.image.digest === input.connectedWorkerImageDigest;
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
          Boolean(primeWorker) &&
          input.connectedEngineConfigured &&
          registered.has("connected-prime-rl") &&
          (input.connectedWorkerImageDigest === null ||
            workerDigestMatches)
        ),
      PRIME_RL_REVISION,
      input.primeRawConfigured
        ? null
        : !primeWorker
        ? "Install a verified signed prime-rl worker catalog entry."
        : !input.connectedEngineConfigured
          ? "Configure an authenticated connected or managed worker route."
          : input.connectedWorkerImageDigest !== null &&
              !workerDigestMatches
            ? "The configured worker image does not match the verified signed catalog."
            : !registered.has("connected-prime-rl")
              ? "Register the connected training engine."
              : null,
    ),
    engine("local-mlx", ["sft"], ["demonstration"], false, "mlx-unqualified", "The MLX worker has no conformance receipt on this host."),
    engine("fireworks-native", ["sft", "grpo"], ["demonstration", "trajectory", "reward"], fireworksAvailable && registered.has("fireworks-native"), "provider-managed", !fireworksAvailable ? "Fireworks is not configured." : !registered.has("fireworks-native") ? "The Fireworks adapter is not registered." : null),
  ];
}

function runtimeCapabilities(
  checkedAt: string,
  adapters: HarnessRuntimeCapabilities[],
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
  const defaults = [
    runtime("local-harness", ["local"], true),
    runtime("sandbox-latitude", ["remote"], true),
    runtime("provider-native", ["provider_native"], false),
  ];
  return mergeAdapterCapabilities(defaults, adapters);
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

function latitudeDataPlaneReceipt(): NonNullable<
  HarnessRuntimeTargetBinding["dataPlane"]
> {
  const content = {
    provider: "latitude",
    dataPlaneId: "openpond-latitude-staging",
    cellId: "openpond-latitude-staging-k8s",
    runnerPoolId: "openpond-latitude-staging-k8s:default",
    runtimeImageDigest: `sha256:${sha256("openpond-latitude-runtime-v1")}`,
  };
  return { ...content, capabilityReceipt: contentHash(content) };
}

function computeIdForDestination(destinationId: string): string {
  const values: Record<string, string> = {
    local_cpu_fixture: "local-cpu",
    local_cuda: "local-cuda",
    local_mlx: "local-mlx",
    ssh_gpu: "ssh-worker",
    prime_hosted: "prime-raw",
    openpond_managed: "sandbox-connected-gpu",
    fireworks: "fireworks-managed",
  };
  return values[destinationId] ?? "unsupported";
}

function engineIdForDestination(destinationId: string): string {
  const values: Record<string, string> = {
    local_cpu_fixture: "local-trl",
    local_cuda: "connected-prime-rl",
    local_mlx: "local-mlx",
    ssh_gpu: "connected-prime-rl",
    prime_hosted: "connected-prime-rl",
    openpond_managed: "connected-prime-rl",
    fireworks: "fireworks-native",
  };
  return values[destinationId] ?? "unsupported";
}
