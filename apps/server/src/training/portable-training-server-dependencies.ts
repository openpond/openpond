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
 * Desktop composition intentionally owns only local compute. OpenPond Managed
 * is a Sandbox API adapter and does not give the desktop raw worker leases.
 */
export function createPortableTrainingServerDependencies(input: {
  adapters?: PortableTrainingAdapterComposition;
  storeDir?: string;
  environment?: NodeJS.ProcessEnv;
}) {
  return {
    registerPortableAdapters(registry: TrainingAdapterRegistry) {
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
