import type {
  ComputeInventory,
  ComputeTargetCapabilities,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { LocalComputeTargetAdapter } from "@openpond/trainer-local";
import {
  RoutedTrainingEngineAdapter,
  type ComputeTargetAdapter,
  type TrainingAdapterRegistry,
  type TrainingEngineRoute,
} from "@openpond/training-sdk";
import {
  createConfiguredConnectedWorker,
  type ConnectedWorkerEnvironment,
} from "./configured-connected-worker.js";
import {
  createConfiguredPrimeRaw,
  type PrimeRawEnvironment,
} from "./configured-prime-raw.js";

type PortableTrainingEnvironment = ConnectedWorkerEnvironment &
  PrimeRawEnvironment;

export type PortableTrainingAdapterComposition = {
  compute?: ComputeTargetAdapter[];
  workerImageDigest?: string;
  primeRawConfigured?: boolean;
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
  const configuredPrime = createConfiguredPrimeRaw({
    storeDir: input.storeDir,
    environment: input.environment,
  });
  const composedAdapters = mergePortableAdapterComposition(
    input.adapters,
    configuredPrime ?? undefined,
  );
  return {
    connectedWorkerConfigured: configuredConnectedWorker !== null,
    connectedEngineConfigured:
      configuredConnectedWorker !== null ||
      composedAdapters.primeRawConfigured === true,
    primeRawConfigured:
      composedAdapters.primeRawConfigured === true,
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
            plan.compute.adapterId === "ssh-worker",
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
    engineRoutes: [
      ...(first?.engineRoutes ?? []),
      ...(second?.engineRoutes ?? []),
    ],
    workerImageDigest:
      second?.workerImageDigest ?? first?.workerImageDigest,
    primeRawConfigured:
      first?.primeRawConfigured === true ||
      second?.primeRawConfigured === true,
  };
}

const localComputeDefinitions = [
  { id: "local-cpu", runtime: "cpu" },
] as const;

function localComputeDevices(
  inventory: ComputeInventory | null,
  runtime: "cpu",
): ComputeTargetCapabilities["devices"] {
  const devices =
    inventory?.devices
      .filter((device) => {
        return device.available && device.kind === "cpu";
      })
      .map((device) => ({
        id: device.id,
        kind: device.kind,
        vendor: device.vendor,
        name: device.name,
        memoryBytes: device.totalMemoryBytes,
        runtime,
      })) ?? [];
  if (devices.length > 0) return devices;
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
