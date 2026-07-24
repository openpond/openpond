import type {
  AdapterValidationReceipt,
  LearningSignalBatch,
  ResolvedTrainingPlan,
  TrainingApproval,
  TrainingArtifact,
  TrainingArtifacts,
  TrainingEngineCapabilities,
  TrainingExecutionRef,
  TrainingExecutionStatus,
  TrainingJob,
  TrainingJobEvent,
  TrainingCatalog,
  TrainingPlan,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  TrainingAdapterRegistry,
  type TrainingDestinationRegistry,
  type TrainingEngineAdapter,
} from "@openpond/training-sdk";
import {
  FireworksTrainingEngineAdapter,
  type FireworksManagedTrainingClient,
} from "@openpond/trainer-fireworks";
import {
  LocalTrainingEngineAdapter,
  type LocalEngineWorker,
} from "@openpond/trainer-local";

import type { SqliteStore } from "../store/store.js";

export type PortableDestinationExecutionContext = {
  plan: TrainingPlan;
  approval: TrainingApproval;
  manifestHash: string;
};

type DestinationBridgeDependencies = {
  adapterId: string;
  capabilities(): Promise<TrainingEngineCapabilities>;
  launch(context: PortableDestinationExecutionContext): Promise<TrainingJob>;
  status(jobId: string): Promise<TrainingJob>;
  cancel(jobId: string): Promise<TrainingJob>;
  collect(jobId: string): Promise<TrainingArtifact[]>;
  events(jobId: string): Promise<TrainingJobEvent[]>;
};

export function createPortableDestinationAdapterRegistry(input: {
  destinations: TrainingDestinationRegistry;
  store: SqliteStore;
  catalog(): Promise<TrainingCatalog>;
}) {
  const adapters = new TrainingAdapterRegistry();
  const bridges = new Map<string, PortableDestinationEngineBridge>();
  const register = (definition: {
    adapterId: string;
    destinationId: Parameters<TrainingDestinationRegistry["get"]>[0];
    createAdapter(
      bridge: PortableDestinationEngineBridge,
      adapterId: string,
    ): TrainingEngineAdapter;
  }) => {
    const bridge = new PortableDestinationEngineBridge({
      adapterId: definition.adapterId,
      capabilities: async () => {
        const capabilities = (await input.catalog()).engines.find(
          (candidate) =>
            candidate.adapterId === definition.adapterId,
        );
        if (!capabilities) {
          throw new Error(
            `Portable engine capabilities ${definition.adapterId} are unavailable.`,
          );
        }
        return capabilities;
      },
      launch: async ({ plan, approval }) => {
        const destination = input.destinations.get(
          definition.destinationId,
        );
        const existing = (await input.store.listTrainingJobs()).find(
          (job) => job.approvalId === approval.id,
        );
        if (existing) {
          try {
            return await destination.status(existing.id);
          } catch {
            return existing;
          }
        }
        return input.store.saveTrainingJob(
          await destination.launch(plan, approval),
        );
      },
      status: (jobId) =>
        input.destinations
          .get(definition.destinationId)
          .status(jobId),
      cancel: (jobId) =>
        input.destinations
          .get(definition.destinationId)
          .cancel(jobId),
      collect: (jobId) =>
        input.destinations
          .get(definition.destinationId)
          .collect(jobId),
      events: (jobId) => input.store.listTrainingJobEvents(jobId),
    });
    bridges.set(definition.adapterId, bridge);
    adapters.registerEngine(
      definition.createAdapter(bridge, definition.adapterId),
    );
  };
  register({
    adapterId: "local-trl",
    destinationId: "local_cpu_fixture",
    createAdapter: (bridge, adapterId) =>
      new LocalTrainingEngineAdapter(
        bridge.localWorker(),
        adapterId,
      ),
  });
  register({
    adapterId: "fireworks-native",
    destinationId: "fireworks",
    createAdapter: (bridge, adapterId) =>
      new FireworksTrainingEngineAdapter(
        bridge.fireworksClient(),
        adapterId,
      ),
  });
  return { adapters, bridges };
}

/**
 * Adapts persisted destination clients to portable engine package contracts.
 * Provider and method selection remains exclusively in TrainingAdapterRegistry.
 */
export class PortableDestinationEngineBridge {
  private readonly contexts = new Map<
    string,
    PortableDestinationExecutionContext
  >();
  private readonly manifestHashes = new Map<string, string>();

  constructor(private readonly deps: DestinationBridgeDependencies) {}

  register(
    resolvedPlanHash: string,
    context: PortableDestinationExecutionContext,
  ): void {
    this.contexts.set(resolvedPlanHash, context);
  }

  localWorker(): LocalEngineWorker {
    return {
      capabilities: () => this.deps.capabilities(),
      validate: (plan) => this.validate(plan),
      launch: (plan) => this.launch(plan),
      consumeSignals: (ref, batch) => this.consumeSignals(ref, batch),
      status: (ref) => this.status(ref),
      logs: (ref, cursor) => this.logs(ref, cursor),
      cancel: (ref) => this.cancel(ref),
      collect: (ref) => this.collect(ref),
    };
  }

  fireworksClient(): FireworksManagedTrainingClient {
    return {
      capabilities: () => this.deps.capabilities(),
      validate: (plan) => this.validate(plan),
      uploadSignals: async ({ manifestId, manifestHash, batch }) => {
        if (
          batch.manifestId !== manifestId ||
          batch.manifestHash !== manifestHash
        ) {
          throw new Error("Fireworks signal upload changed manifest lineage.");
        }
        return {
          datasetId: `evidence-${manifestId}`,
          immutableRevision: contentHash(batch),
        };
      },
      launch: ({ plan }) => this.launch(plan),
      status: (ref) => this.status(ref),
      logs: (ref, cursor) => this.logs(ref, cursor),
      cancel: (ref) => this.cancel(ref),
      collect: (ref) => this.collect(ref),
    };
  }

  private async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    const context = this.contexts.get(plan.contentHash);
    const issues: AdapterValidationReceipt["issues"] = [];
    if (!context) {
      issues.push({
        code: "execution_context_missing",
        path: "contentHash",
        message:
          "The portable plan has no revalidated persisted destination context.",
      });
    } else {
      if (context.manifestHash !== plan.manifest.contentHash) {
        issues.push({
          code: "manifest_lineage_changed",
          path: "manifest.contentHash",
          message: "The Harness Run Manifest changed after preparation.",
        });
      }
      if (context.approval.maximumCostUsd !== plan.maximumSpendUsd) {
        issues.push({
          code: "approval_spend_changed",
          path: "maximumSpendUsd",
          message: "The approved maximum spend changed after preparation.",
        });
      }
    }
    const base = {
      schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
      adapterId: this.deps.adapterId,
      valid: issues.length === 0,
      issues,
      capabilityReceipt: plan.engine.capabilityReceipt,
      planHash: plan.contentHash,
      createdAt: new Date().toISOString(),
    };
    return { ...base, contentHash: contentHash(base) };
  }

  private async launch(
    plan: ResolvedTrainingPlan,
  ): Promise<TrainingExecutionRef> {
    const context = this.contexts.get(plan.contentHash);
    if (!context) {
      throw new Error("Portable destination execution context is missing.");
    }
    const job = await this.deps.launch(context);
    this.manifestHashes.set(job.id, plan.manifest.contentHash);
    return {
      runId: job.id,
      adapterId: this.deps.adapterId,
      providerJobId:
        typeof job.metadata.providerJobId === "string"
          ? job.metadata.providerJobId
          : null,
      leaseId: null,
      createdAt: job.createdAt,
    };
  }

  private async consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void> {
    const manifestHash = this.manifestHashes.get(ref.runId);
    if (
      (manifestHash && manifestHash !== batch.manifestHash) ||
      batch.manifestId.length === 0
    ) {
      throw new Error("Learning signals do not match this execution.");
    }
  }

  private async status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    return toPortableStatus(await this.deps.status(ref.runId));
  }

  private async logs(ref: TrainingExecutionRef, cursor?: string) {
    const events = await this.deps.events(ref.runId);
    const start = parseCursor(cursor);
    const selected = events.filter((event) => event.sequence >= start);
    return {
      cursor: String(
        selected.length > 0
          ? selected[selected.length - 1]!.sequence + 1
          : start,
      ),
      entries: selected.map((event) => ({
        timestamp: event.timestamp,
        level:
          event.type === "failure" ? ("error" as const) : ("info" as const),
        message: eventMessage(event),
      })),
    };
  }

  private async cancel(ref: TrainingExecutionRef): Promise<void> {
    await this.deps.cancel(ref.runId);
  }

  private async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const artifacts = (await this.deps.collect(ref.runId)).map(toPortableArtifact);
    const manifestHash =
      this.manifestHashes.get(ref.runId) ??
      (await this.deps.status(ref.runId)).metadata.harnessRunManifestHash;
    if (typeof manifestHash !== "string") {
      throw new Error("Training artifacts have no Harness Run Manifest lineage.");
    }
    const base = { runId: ref.runId, manifestHash, artifacts };
    return { ...base, contentHash: contentHash(base) };
  }
}

function toPortableStatus(job: TrainingJob): TrainingExecutionStatus {
  const state: TrainingExecutionStatus["state"] =
    job.status === "queued"
      ? "queued"
      : job.status === "starting" || job.status === "reconciling"
        ? "preparing"
        : job.status;
  return {
    runId: job.id,
    state,
    phase:
      typeof job.metadata.phase === "string" ? job.metadata.phase : job.status,
    progress:
      typeof job.metadata.progress === "number" &&
      job.metadata.progress >= 0 &&
      job.metadata.progress <= 1
        ? job.metadata.progress
        : null,
    updatedAt: job.updatedAt,
    errorCode: job.error ? "destination_execution_failed" : null,
  };
}

function toPortableArtifact(
  artifact: TrainingArtifact,
): TrainingArtifacts["artifacts"][number] {
  const kind: TrainingArtifacts["artifacts"][number]["kind"] =
    artifact.kind === "log"
      ? "trace"
      : artifact.kind === "manifest"
        ? "receipt"
        : artifact.kind;
  return {
    kind,
    objectRef: artifact.path,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  };
}

function eventMessage(event: TrainingJobEvent): string {
  if (typeof event.payload.message === "string") return event.payload.message;
  if (typeof event.payload.error === "string") return event.payload.error;
  return `${event.type}: ${JSON.stringify(event.payload)}`;
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
