import {
  TrainingEngineCapabilitiesSchema,
  type AdapterValidationReceipt,
  type ComputeTargetCapabilities,
  type LearningSignalBatch,
  type ResolvedTrainingPlan,
  type TrainingArtifacts,
  type TrainingEngineCapabilities,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export type ComputeRequest = {
  runId: string;
  deviceOrPool: string;
  workerImageDigest: string | null;
  maximumSpendUsd: number | null;
  deadline: string;
};

export type ComputeQuote = {
  adapterId: string;
  estimatedCostUsd: number | null;
  hourlyCostUsd: number | null;
  expiresAt: string;
  assumptions: string[];
  contentHash: string;
};

export type ComputeLease = {
  id: string;
  adapterId: string;
  deviceOrPool: string;
  acquiredAt: string;
  expiresAt: string;
  capabilityReceipt: string;
  connection: Record<string, unknown>;
};

export interface TrainingEngineAdapter {
  readonly id: string;
  capabilities(): Promise<TrainingEngineCapabilities>;
  validate(plan: ResolvedTrainingPlan): Promise<AdapterValidationReceipt>;
  launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef>;
  consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void>;
  status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus>;
  logs(ref: TrainingExecutionRef, cursor?: string): Promise<{
    cursor: string;
    entries: Array<{ timestamp: string; level: string; message: string }>;
  }>;
  cancel(ref: TrainingExecutionRef): Promise<void>;
  collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts>;
}

export interface ComputeTargetAdapter {
  readonly id: string;
  discover(): Promise<ComputeTargetCapabilities>;
  quote(request: ComputeRequest): Promise<ComputeQuote>;
  acquire(request: ComputeRequest): Promise<ComputeLease>;
  heartbeat(lease: ComputeLease): Promise<ComputeLease>;
  release(lease: ComputeLease): Promise<void>;
}

export type TrainingEngineRoute = {
  id: string;
  matches(plan: ResolvedTrainingPlan): boolean;
  adapter: TrainingEngineAdapter;
};

/**
 * Keeps one canonical engine adapter ID while selecting a concrete transport
 * from the resolved compute/runtime bindings. The selected route is persisted
 * in TrainingExecutionRef so status, cancellation, and collection survive
 * process restarts without inferring a provider from IDs.
 */
export class RoutedTrainingEngineAdapter implements TrainingEngineAdapter {
  readonly id: string;
  private readonly routes: Map<string, TrainingEngineRoute>;

  constructor(id: string, routes: TrainingEngineRoute[]) {
    if (!id.trim() || routes.length === 0) {
      throw new Error("A routed training engine requires an ID and routes.");
    }
    this.id = id;
    this.routes = new Map();
    for (const route of routes) {
      if (!route.id.trim() || this.routes.has(route.id)) {
        throw new Error(`Training engine route ${route.id} is invalid or duplicated.`);
      }
      this.routes.set(route.id, route);
    }
  }

  async capabilities(): Promise<TrainingEngineCapabilities> {
    const capabilities = await Promise.all(
      [...this.routes.values()].map((route) => route.adapter.capabilities()),
    );
    const protocolVersions = new Set(
      capabilities.map((item) => item.workerProtocolVersion),
    );
    const upstreamRevisions = new Set(
      capabilities.map((item) => item.upstreamRevision),
    );
    if (protocolVersions.size !== 1 || upstreamRevisions.size !== 1) {
      throw new Error(
        "Training engine routes disagree on protocol or upstream revision.",
      );
    }
    const available = capabilities.some((item) => item.available);
    const methods = union(capabilities.flatMap((item) => item.methods));
    const signalKinds = union(
      capabilities.flatMap((item) => item.signalKinds),
    );
    const modelFamilies = union(
      capabilities.flatMap((item) => item.modelFamilies),
    );
    const precisions = union(
      capabilities.flatMap((item) => item.precisions),
    );
    const topologies = union(
      capabilities.flatMap((item) => item.topologies),
    );
    const checkedAt = capabilities
      .map((item) => item.checkedAt)
      .sort()
      .at(-1)!;
    return TrainingEngineCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingEngineCapabilities.v1",
      adapterId: this.id,
      available,
      methods,
      signalKinds,
      modelFamilies,
      precisions,
      topologies,
      workerProtocolVersion: [...protocolVersions][0],
      upstreamRevision: [...upstreamRevisions][0],
      capabilityReceipt: contentHash(
        [...this.routes.entries()].map(([routeId], index) => ({
          routeId,
          capabilityReceipt: capabilities[index]!.capabilityReceipt,
        })),
      ),
      checkedAt,
      unavailableReason: available
        ? null
        : capabilities
            .map((item) => item.unavailableReason)
            .filter((reason): reason is string => Boolean(reason))
            .join("; ") || "No training engine route is available.",
    });
  }

  validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    return this.routeForPlan(plan).adapter.validate(plan);
  }

  async launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    const route = this.routeForPlan(plan);
    const ref = await route.adapter.launch(plan);
    return {
      ...ref,
      adapterId: this.id,
      routeId: route.id,
    };
  }

  consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void> {
    const route = this.routeForRef(ref);
    return route.adapter.consumeSignals(this.routeRef(ref, route), batch);
  }

  status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    const route = this.routeForRef(ref);
    return route.adapter.status(this.routeRef(ref, route));
  }

  logs(ref: TrainingExecutionRef, cursor?: string) {
    const route = this.routeForRef(ref);
    return route.adapter.logs(this.routeRef(ref, route), cursor);
  }

  cancel(ref: TrainingExecutionRef): Promise<void> {
    const route = this.routeForRef(ref);
    return route.adapter.cancel(this.routeRef(ref, route));
  }

  collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const route = this.routeForRef(ref);
    return route.adapter.collect(this.routeRef(ref, route));
  }

  private routeForPlan(plan: ResolvedTrainingPlan): TrainingEngineRoute {
    const matches = [...this.routes.values()].filter((route) =>
      route.matches(plan),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Training engine ${this.id} requires exactly one matching route; found ${matches.length}.`,
      );
    }
    return matches[0]!;
  }

  private routeForRef(ref: TrainingExecutionRef): TrainingEngineRoute {
    if (!ref.routeId) {
      if (this.routes.size === 1) return [...this.routes.values()][0]!;
      throw new Error(
        `Training execution ${ref.runId} has no persisted engine route.`,
      );
    }
    const route = this.routes.get(ref.routeId);
    if (!route) {
      throw new Error(
        `Training execution ${ref.runId} references unknown route ${ref.routeId}.`,
      );
    }
    return route;
  }

  private routeRef(
    ref: TrainingExecutionRef,
    route: TrainingEngineRoute,
  ): TrainingExecutionRef {
    return {
      ...ref,
      adapterId: route.adapter.id,
    };
  }
}

export class TrainingAdapterRegistry {
  private readonly engines = new Map<string, TrainingEngineAdapter>();
  private readonly compute = new Map<string, ComputeTargetAdapter>();

  registerEngine(adapter: TrainingEngineAdapter): void {
    register(this.engines, adapter);
  }

  registerCompute(adapter: ComputeTargetAdapter): void {
    register(this.compute, adapter);
  }

  engine(id: string): TrainingEngineAdapter {
    return requireAdapter(this.engines, id, "engine");
  }

  hasEngine(id: string): boolean {
    return this.engines.has(id);
  }

  engineIds(): string[] {
    return [...this.engines.keys()].sort();
  }

  computeTarget(id: string): ComputeTargetAdapter {
    return requireAdapter(this.compute, id, "compute");
  }

  hasComputeTarget(id: string): boolean {
    return this.compute.has(id);
  }

  computeTargetIds(): string[] {
    return [...this.compute.keys()].sort();
  }

  async capabilities(): Promise<{
    engines: TrainingEngineCapabilities[];
    compute: ComputeTargetCapabilities[];
  }> {
    return {
      engines: await Promise.all(
        [...this.engines.values()].map((item) => item.capabilities()),
      ),
      compute: await Promise.all(
        [...this.compute.values()].map((item) => item.discover()),
      ),
    };
  }

  async computeCapabilities(): Promise<ComputeTargetCapabilities[]> {
    return Promise.all(
      [...this.compute.values()].map((item) => item.discover()),
    );
  }

}

function union<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right)
  );
}

function register<T extends { id: string }>(
  adapters: Map<string, T>,
  adapter: T,
): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`Training adapter ${adapter.id} is already registered.`);
  }
  adapters.set(adapter.id, adapter);
}

function requireAdapter<T>(
  adapters: Map<string, T>,
  id: string,
  kind: string,
): T {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Training ${kind} adapter ${id} is not registered.`);
  return adapter;
}
