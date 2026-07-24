import type {
  ComputeInventory,
  ComputeTargetCapabilities,
  WorkerCatalogEntry,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  SpawnWorkerImageCommandRunner,
  WorkerImageDistribution,
} from "@openpond/trainer-connected";
import { LocalComputeTargetAdapter } from "@openpond/trainer-local";
import {
  RoutedTrainingEngineAdapter,
  type ComputeTargetAdapter,
  type HarnessRuntimeAdapter,
  type TrainingAdapterRegistry,
  type TrainingEngineRoute,
} from "@openpond/training-sdk";
import {
  createConfiguredConnectedWorker,
  type ConnectedWorkerEnvironment,
} from "./configured-connected-worker.js";
import {
  createConfiguredSandboxM8,
  type SandboxM8Environment,
} from "./configured-sandbox-m8.js";
import {
  createConfiguredPrimeRaw,
  type PrimeRawEnvironment,
} from "./configured-prime-raw.js";
import { createVerifiedWorkerCatalogLoader } from "./worker-catalog-loader.js";

type PortableTrainingEnvironment = ConnectedWorkerEnvironment &
  PrimeRawEnvironment &
  SandboxM8Environment & {
  OPENPOND_WORKER_CATALOG_PATH?: string;
  OPENPOND_WORKER_CATALOG_PUBLIC_KEY_PATH?: string;
  OPENPOND_WORKER_CATALOG_SIGNING_KEY_ID?: string;
};

export type PortableTrainingAdapterComposition = {
  compute?: ComputeTargetAdapter[];
  runtimes?: HarnessRuntimeAdapter[];
  workerImageDigest?: string;
  primeRawConfigured?: boolean;
  sandboxManagedConfigured?: boolean;
  engineRoutes?: Array<{
    canonicalEngineId: string;
    route: TrainingEngineRoute;
  }>;
};

export function createPortableTrainingServerDependencies(input: {
  storeDir: string;
  environment: PortableTrainingEnvironment;
  computeInventory?: () => Promise<ComputeInventory | null>;
  adapters?: PortableTrainingAdapterComposition;
}) {
  const configuredConnectedWorker = createConfiguredConnectedWorker({
    storeDir: input.storeDir,
    environment: input.environment,
  });
  const configuredSandbox = createConfiguredSandboxM8({
    storeDir: input.storeDir,
    environment: input.environment,
  });
  const configuredPrime = createConfiguredPrimeRaw({
    storeDir: input.storeDir,
    environment: input.environment,
  });
  const composedAdapters = mergePortableAdapterComposition(
    mergePortableAdapterComposition(
      input.adapters,
      configuredPrime ?? undefined,
    ),
    configuredSandbox?.adapters,
  );
  const workerImages = new WorkerImageDistribution(
    new SpawnWorkerImageCommandRunner(),
  );
  return {
    workerCatalog: createVerifiedWorkerCatalogLoader({
      catalogPath: input.environment.OPENPOND_WORKER_CATALOG_PATH,
      publicKeyPath:
        input.environment.OPENPOND_WORKER_CATALOG_PUBLIC_KEY_PATH,
      expectedOpenpondRelease: "0.0.38",
      expectedWorkerProtocolVersion: "openpond.connectedWorker.v1",
      expectedSigningKeyId:
        input.environment.OPENPOND_WORKER_CATALOG_SIGNING_KEY_ID,
    }),
    workerImages: {
      inspect: (entry: WorkerCatalogEntry) => workerImages.inspect(entry),
      prepare: (entry: WorkerCatalogEntry) =>
        workerImages.prepare({ entry }),
    },
    connectedWorkerConfigured: configuredConnectedWorker !== null,
    connectedEngineConfigured:
      configuredConnectedWorker !== null ||
      composedAdapters.primeRawConfigured === true ||
      composedAdapters.sandboxManagedConfigured === true,
    primeRawConfigured:
      composedAdapters.primeRawConfigured === true,
    sandboxManagedConfigured:
      composedAdapters.sandboxManagedConfigured === true,
    sandboxBinding: configuredSandbox?.binding ?? null,
    connectedWorkerImageDigest:
      input.environment.OPENPOND_CONNECTED_WORKER_IMAGE_DIGEST ??
      composedAdapters.workerImageDigest ??
      null,
    registerPortableAdapters(registry: TrainingAdapterRegistry) {
      for (const definition of localComputeDefinitions) {
        registry.registerCompute(
          new LocalComputeTargetAdapter(
            {
              discover: async () => {
                const inventory = await input.computeInventory?.() ?? null;
                const devices = localComputeDevices(
                  inventory,
                  definition.runtime,
                );
                const checkedAt =
                  inventory?.scannedAt ?? new Date().toISOString();
                return {
                  devices,
                  workerImagesSupported:
                    definition.runtime !== "cpu",
                  capabilityReceipt: contentHash({
                    adapterId: definition.id,
                    devices,
                    checkedAt,
                  }),
                  checkedAt,
                };
              },
            },
            definition.id,
          ),
        );
      }
      for (const adapter of composedAdapters.compute ?? []) {
        registry.registerCompute(adapter);
      }
      for (const adapter of composedAdapters.runtimes ?? []) {
        registry.registerRuntime(adapter);
      }
      const engineRoutes = new Map<string, TrainingEngineRoute[]>();
      const addEngineRoute = (
        canonicalEngineId: string,
        route: TrainingEngineRoute,
      ) => {
        const current = engineRoutes.get(canonicalEngineId) ?? [];
        current.push(route);
        engineRoutes.set(canonicalEngineId, current);
      };
      if (configuredConnectedWorker) {
        addEngineRoute("connected-prime-rl", {
          id: "configured-connected-worker",
          matches: (plan) =>
            plan.compute.adapterId === "ssh-worker" ||
            plan.compute.adapterId === "local-cuda",
          adapter: configuredConnectedWorker,
        });
      }
      for (const definition of composedAdapters.engineRoutes ?? []) {
        addEngineRoute(
          definition.canonicalEngineId,
          definition.route,
        );
      }
      for (const [engineId, routes] of engineRoutes) {
        registry.registerEngine(
          new RoutedTrainingEngineAdapter(engineId, routes),
        );
      }
    },
  };
}

function mergePortableAdapterComposition(
  first: PortableTrainingAdapterComposition | undefined,
  second: PortableTrainingAdapterComposition | undefined,
): PortableTrainingAdapterComposition {
  if (
    first?.workerImageDigest &&
    second?.workerImageDigest &&
    first.workerImageDigest !== second.workerImageDigest
  ) {
    throw new Error(
      "Portable training engine routes require one exact worker image digest.",
    );
  }
  return {
    compute: [...(first?.compute ?? []), ...(second?.compute ?? [])],
    runtimes: [
      ...(first?.runtimes ?? []),
      ...(second?.runtimes ?? []),
    ],
    engineRoutes: [
      ...(first?.engineRoutes ?? []),
      ...(second?.engineRoutes ?? []),
    ],
    workerImageDigest:
      second?.workerImageDigest ?? first?.workerImageDigest,
    primeRawConfigured:
      first?.primeRawConfigured === true ||
      second?.primeRawConfigured === true,
    sandboxManagedConfigured:
      first?.sandboxManagedConfigured === true ||
      second?.sandboxManagedConfigured === true,
  };
}

const localComputeDefinitions = [
  { id: "local-cpu", runtime: "cpu" },
  { id: "local-cuda", runtime: "cuda" },
  { id: "local-mlx", runtime: "mlx" },
] as const;

function localComputeDevices(
  inventory: ComputeInventory | null,
  runtime: (typeof localComputeDefinitions)[number]["runtime"],
): ComputeTargetCapabilities["devices"] {
  const devices =
    inventory?.devices
      .filter((device) => {
        if (!device.available) return false;
        if (runtime === "cuda") return device.vendor === "nvidia";
        if (runtime === "mlx") return device.vendor === "apple";
        return device.kind === "cpu";
      })
      .map((device) => ({
        id: device.id,
        kind: device.kind,
        vendor: device.vendor,
        name: device.name,
        memoryBytes: device.totalMemoryBytes,
        runtime,
      })) ?? [];
  if (devices.length > 0 || runtime !== "cpu") return devices;
  return [
    {
      id: "cpu",
      kind: "cpu",
      vendor: "other",
      name: "Local CPU",
      memoryBytes: null,
      runtime: "cpu",
    },
  ];
}
