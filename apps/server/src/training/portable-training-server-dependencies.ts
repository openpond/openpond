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

export type PortableTrainingAdapterComposition = {
  compute?: ComputeTargetAdapter[];
  engineRoutes?: Array<{
    canonicalEngineId: string;
    route: TrainingEngineRoute;
  }>;
};

/**
 * Desktop composition intentionally owns only local compute. Fireworks is a
 * provider-native destination and OpenPond Managed is a Sandbox API adapter;
 * neither gives the desktop raw provider credentials or worker leases.
 */
export function createPortableTrainingServerDependencies(input: {
  computeInventory?: () => Promise<ComputeInventory | null>;
  adapters?: PortableTrainingAdapterComposition;
  storeDir?: string;
  environment?: NodeJS.ProcessEnv;
}) {
  return {
    registerPortableAdapters(registry: TrainingAdapterRegistry) {
      registry.registerCompute(
        new LocalComputeTargetAdapter(
          {
            discover: async () => {
              const inventory = (await input.computeInventory?.()) ?? null;
              const devices = localComputeDevices(inventory);
              const checkedAt =
                inventory?.scannedAt ?? new Date().toISOString();
              return {
                devices,
                workerImagesSupported: false,
                capabilityReceipt: contentHash({
                  adapterId: "local-cpu",
                  devices,
                  checkedAt,
                }),
                checkedAt,
              };
            },
          },
          "local-cpu",
        ),
      );
      for (const adapter of input.adapters?.compute ?? []) {
        registry.registerCompute(adapter);
      }
      const engineRoutes = new Map<string, TrainingEngineRoute[]>();
      for (const definition of input.adapters?.engineRoutes ?? []) {
        const routes =
          engineRoutes.get(definition.canonicalEngineId) ?? [];
        routes.push(definition.route);
        engineRoutes.set(definition.canonicalEngineId, routes);
      }
      for (const [engineId, routes] of engineRoutes) {
        registry.registerEngine(
          new RoutedTrainingEngineAdapter(engineId, routes),
        );
      }
    },
  };
}

function localComputeDevices(
  inventory: ComputeInventory | null,
): ComputeTargetCapabilities["devices"] {
  const devices =
    inventory?.devices
      .filter((device) => device.available && device.kind === "cpu")
      .map((device) => ({
        id: device.id,
        kind: device.kind,
        vendor: device.vendor,
        name: device.name,
        memoryBytes: device.totalMemoryBytes,
        runtime: "cpu",
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
