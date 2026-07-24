import {
  AdapterValidationReceiptSchema,
  ComputeTargetCapabilitiesSchema,
  HarnessRuntimeCapabilitiesSchema,
  TrainingArtifactsSchema,
  TrainingEngineCapabilitiesSchema,
  TrainingExecutionStatusSchema,
  type AdapterValidationReceipt,
  type ComputeTargetCapabilities,
  type HarnessGraderEvidence,
  type HarnessRelease,
  type HarnessRunManifest,
  type HarnessRuntimeCapabilities,
  type LearningSignalBatch,
  type ModelAction,
  type ResolvedTrainingPlan,
  type ToolObservation,
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

export type HarnessLease = {
  id: string;
  adapterId: string;
  manifestId: string;
  acquiredAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
};

export type HarnessArtifacts = {
  traceRefs: string[];
  artifactRefs: string[];
  contentHash: string;
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

export interface HarnessRuntimeAdapter {
  readonly id: string;
  capabilities(): Promise<HarnessRuntimeCapabilities>;
  materialize(release: HarnessRelease): Promise<{ bundleHash: string }>;
  create(manifest: HarnessRunManifest): Promise<HarnessLease>;
  reset(lease: HarnessLease, seed: string): Promise<void>;
  step(lease: HarnessLease, action: ModelAction): Promise<ToolObservation>;
  grade(lease: HarnessLease): Promise<HarnessGraderEvidence[]>;
  collect(lease: HarnessLease): Promise<HarnessArtifacts>;
  destroy(lease: HarnessLease): Promise<void>;
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
  private readonly runtimes = new Map<string, HarnessRuntimeAdapter>();

  registerEngine(adapter: TrainingEngineAdapter): void {
    register(this.engines, adapter);
  }

  registerCompute(adapter: ComputeTargetAdapter): void {
    register(this.compute, adapter);
  }

  registerRuntime(adapter: HarnessRuntimeAdapter): void {
    register(this.runtimes, adapter);
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

  runtime(id: string): HarnessRuntimeAdapter {
    return requireAdapter(this.runtimes, id, "runtime");
  }

  hasRuntime(id: string): boolean {
    return this.runtimes.has(id);
  }

  runtimeIds(): string[] {
    return [...this.runtimes.keys()].sort();
  }

  async capabilities(): Promise<{
    engines: TrainingEngineCapabilities[];
    compute: ComputeTargetCapabilities[];
    runtimes: HarnessRuntimeCapabilities[];
  }> {
    return {
      engines: await Promise.all(
        [...this.engines.values()].map((item) => item.capabilities()),
      ),
      compute: await Promise.all(
        [...this.compute.values()].map((item) => item.discover()),
      ),
      runtimes: await Promise.all(
        [...this.runtimes.values()].map((item) => item.capabilities()),
      ),
    };
  }

  async computeCapabilities(): Promise<ComputeTargetCapabilities[]> {
    return Promise.all(
      [...this.compute.values()].map((item) => item.discover()),
    );
  }

  async runtimeCapabilities(): Promise<HarnessRuntimeCapabilities[]> {
    return Promise.all(
      [...this.runtimes.values()].map((item) => item.capabilities()),
    );
  }
}

function union<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right)
  );
}

export async function runEngineAdapterConformance(input: {
  adapter: TrainingEngineAdapter;
  plan: ResolvedTrainingPlan;
  signals: LearningSignalBatch;
}): Promise<{ passed: boolean; checks: AdapterConformanceCheck[] }> {
  const checks: AdapterConformanceCheck[] = [];
  const capabilities = TrainingEngineCapabilitiesSchema.parse(
    await input.adapter.capabilities(),
  );
  checks.push(check("capabilities", capabilities.adapterId === input.adapter.id));
  const validation = AdapterValidationReceiptSchema.parse(
    await input.adapter.validate(input.plan),
  );
  checks.push(check("validation", validation.valid));
  if (!validation.valid) return result(checks);
  const ref = await input.adapter.launch(input.plan);
  checks.push(check("launch", ref.adapterId === input.adapter.id));
  await input.adapter.consumeSignals(ref, input.signals);
  checks.push(check("signals", true));
  const status = TrainingExecutionStatusSchema.parse(
    await input.adapter.status(ref),
  );
  checks.push(check("status", status.runId === ref.runId));
  await input.adapter.logs(ref);
  checks.push(check("logs", true));
  await input.adapter.cancel(ref);
  checks.push(check("cancel", true));
  const artifacts = TrainingArtifactsSchema.parse(
    await input.adapter.collect(ref),
  );
  checks.push(
    check(
      "artifacts",
      artifacts.runId === ref.runId &&
        artifacts.contentHash ===
          contentHash({
            runId: artifacts.runId,
            manifestHash: artifacts.manifestHash,
            artifacts: artifacts.artifacts,
          }),
    ),
  );
  return result(checks);
}

export async function runComputeAdapterConformance(input: {
  adapter: ComputeTargetAdapter;
  request: ComputeRequest;
}): Promise<{ passed: boolean; checks: AdapterConformanceCheck[] }> {
  const checks: AdapterConformanceCheck[] = [];
  const capabilities = ComputeTargetCapabilitiesSchema.parse(
    await input.adapter.discover(),
  );
  checks.push(check("discover", capabilities.adapterId === input.adapter.id));
  const quote = await input.adapter.quote(input.request);
  checks.push(check("quote", quote.adapterId === input.adapter.id));
  const lease = await input.adapter.acquire(input.request);
  checks.push(check("acquire", lease.adapterId === input.adapter.id));
  const heartbeat = await input.adapter.heartbeat(lease);
  checks.push(check("heartbeat", heartbeat.id === lease.id));
  await input.adapter.release(heartbeat);
  checks.push(check("release", true));
  return result(checks);
}

export async function runRuntimeAdapterConformance(input: {
  adapter: HarnessRuntimeAdapter;
  release: HarnessRelease;
  manifest: HarnessRunManifest;
  action: ModelAction;
}): Promise<{ passed: boolean; checks: AdapterConformanceCheck[] }> {
  const checks: AdapterConformanceCheck[] = [];
  const capabilities = HarnessRuntimeCapabilitiesSchema.parse(
    await input.adapter.capabilities(),
  );
  checks.push(check("capabilities", capabilities.adapterId === input.adapter.id));
  await input.adapter.materialize(input.release);
  checks.push(check("materialize", true));
  const lease = await input.adapter.create(input.manifest);
  checks.push(check("create", lease.adapterId === input.adapter.id));
  await input.adapter.reset(lease, "17");
  checks.push(check("reset", true));
  await input.adapter.step(lease, input.action);
  checks.push(check("step", true));
  await input.adapter.grade(lease);
  checks.push(check("grade", true));
  await input.adapter.collect(lease);
  checks.push(check("collect", true));
  await input.adapter.destroy(lease);
  checks.push(check("destroy", true));
  return result(checks);
}

type AdapterConformanceCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

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

function check(name: string, passed: boolean): AdapterConformanceCheck {
  return { name, passed, detail: passed ? "passed" : "failed" };
}

function result(checks: AdapterConformanceCheck[]): {
  passed: boolean;
  checks: AdapterConformanceCheck[];
} {
  return { passed: checks.every((item) => item.passed), checks };
}
