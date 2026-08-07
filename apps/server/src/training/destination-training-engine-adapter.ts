import {
  LearningSignalBatchSchema,
  TrainingExecutionRefSchema,
  type AdapterValidationReceipt,
  type LearningSignalBatch,
  type ResolvedTrainingPlan,
  type TrainingArtifact,
  type TrainingArtifacts,
  type TrainingCatalog,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
  type TrainingJob,
  type TrainingJobEvent,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  TrainingAdapterRegistry,
  type TrainingDestination,
  type TrainingDestinationRegistry,
  type TrainingEngineAdapter,
} from "@openpond/training-sdk";

import type { SqliteStore } from "../store/store.js";
import { OpenPondManagedTrainingAdapter } from "./openpond-managed-training-adapter.js";

/**
 * Registers the provider implementations that still expose the destination
 * protocol as first-class portable engine adapters. The resolved plan carries
 * durable plan/approval references, so launch does not rely on an in-memory
 * bridge or a second adapter wrapper.
 */
export function createDestinationTrainingEngineRegistry(input: {
  destinations: TrainingDestinationRegistry;
  store: SqliteStore;
  storeDir: string;
  resolveManagedAccess?: () => Promise<{
    apiBaseUrl: string;
    token: string;
    teamId: string;
  }>;
  catalog(): Promise<TrainingCatalog>;
}) {
  const adapters = new TrainingAdapterRegistry() as TrainingAdapterRegistry & {
    close(): Promise<void>;
    refreshManagedEvidence(job: TrainingJob): Promise<void>;
  };
  for (const definition of [
    {
      adapterId: "local-trl",
      destinationId: "local_cpu_fixture",
    },
  ] as const) {
    adapters.registerEngine(
      new DestinationTrainingEngineAdapter({
        adapterId: definition.adapterId,
        destination: input.destinations.get(definition.destinationId),
        store: input.store,
        catalog: input.catalog,
      }),
    );
  }
  const managed = new OpenPondManagedTrainingAdapter({
    store: input.store,
    storeDir: input.storeDir,
    resolveAccess: input.resolveManagedAccess,
  });
  adapters.registerEngine(managed);
  adapters.close = () => managed.close();
  adapters.refreshManagedEvidence = async (job) => {
    const parsed = TrainingExecutionRefSchema.safeParse(
      job.metadata.portableExecutionRef,
    );
    if (!parsed.success || parsed.data.adapterId !== "sandbox-managed-rl") {
      return;
    }
    await managed.refreshEvidence(parsed.data);
  };
  return adapters;
}

class DestinationTrainingEngineAdapter implements TrainingEngineAdapter {
  readonly id: string;

  constructor(
    private readonly deps: {
      adapterId: string;
      destination: TrainingDestination;
      store: SqliteStore;
      catalog(): Promise<TrainingCatalog>;
    },
  ) {
    this.id = deps.adapterId;
  }

  async capabilities() {
    const capabilities = (await this.deps.catalog()).engines.find(
      (candidate) => candidate.adapterId === this.id,
    );
    if (!capabilities) {
      throw new Error(`Portable engine capabilities ${this.id} are unavailable.`);
    }
    return capabilities;
  }

  async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    const issues: AdapterValidationReceipt["issues"] = [];
    const context = await this.executionContext(plan);
    if (!context) {
      issues.push({
        code: "execution_context_missing",
        path: "execution",
        message: "The resolved plan has no persisted plan and approval.",
      });
    } else {
      if (context.trainingPlan.destinationId !== this.deps.destination.id) {
        issues.push({
          code: "destination_changed",
          path: "execution.trainingPlanId",
          message: "The persisted plan targets a different destination.",
        });
      }
      if (context.approval.planId !== context.trainingPlan.id) {
        issues.push({
          code: "approval_plan_changed",
          path: "execution.approvalId",
          message: "The approval does not authorize this training plan.",
        });
      }
      if (contentHash(context.approval) !== plan.approvalHash) {
        issues.push({
          code: "approval_changed",
          path: "approvalHash",
          message: "The persisted approval changed after plan resolution.",
        });
      }
      if (context.approval.maximumCostUsd !== plan.maximumSpendUsd) {
        issues.push({
          code: "approval_spend_changed",
          path: "maximumSpendUsd",
          message: "The approved maximum spend changed after plan resolution.",
        });
      }
    }
    const base = {
      schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
      adapterId: this.id,
      valid: issues.length === 0,
      issues,
      capabilityReceipt: plan.engine.capabilityReceipt,
      planHash: plan.contentHash,
      createdAt: new Date().toISOString(),
    };
    return { ...base, contentHash: contentHash(base) };
  }

  async launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    const context = await this.executionContext(plan);
    if (!context) {
      throw new Error("The resolved plan has no persisted execution context.");
    }
    const existing = (await this.deps.store.listTrainingJobs()).find(
      (job) => job.approvalId === context.approval.id,
    );
    const job = existing
      ? await this.deps.destination.status(existing.id).catch(() => existing)
      : await this.deps.store.saveTrainingJob(
          await this.deps.destination.launch(
            context.trainingPlan,
            context.approval,
          ),
        );
    await this.deps.store.saveTrainingJob({
      ...job,
      metadata: {
        ...job.metadata,
        harnessRunManifestId: plan.manifest.id,
        harnessRunManifestHash: plan.manifest.contentHash,
      },
    });
    return {
      runId: job.id,
      adapterId: this.id,
      providerJobId:
        typeof job.metadata.providerJobId === "string"
          ? job.metadata.providerJobId
          : null,
      leaseId: null,
      createdAt: job.createdAt,
    };
  }

  async consumeSignals(
    ref: TrainingExecutionRef,
    input: LearningSignalBatch,
  ): Promise<void> {
    const batch = LearningSignalBatchSchema.parse(input);
    const { contentHash: suppliedHash, ...batchContent } = batch;
    if (contentHash(batchContent) !== suppliedHash) {
      throw new Error("Learning signal batch content hash is invalid.");
    }
    const job =
      (await this.deps.store.getTrainingJob(ref.runId)) ??
      (await this.deps.destination.status(ref.runId));
    if (
      job.metadata.harnessRunManifestId !== batch.manifestId ||
      job.metadata.harnessRunManifestHash !== batch.manifestHash
    ) {
      throw new Error("Learning signals do not match this execution.");
    }
    const storedReceipts = Array.isArray(job.metadata.portableSignalReceipts)
      ? job.metadata.portableSignalReceipts
      : [];
    const receipts = new Map<number, string>(
      storedReceipts.flatMap((receipt) =>
        isSignalReceipt(receipt) ? [[receipt.sequence, receipt.contentHash]] : [],
      ),
    );
    const existing = receipts.get(batch.sequence);
    if (existing) {
      if (existing !== batch.contentHash) {
        throw new Error("A delivered learning signal sequence changed content.");
      }
      return;
    }
    if (batch.sequence !== receipts.size) {
      throw new Error("Learning signal delivery sequence is not contiguous.");
    }
    if (!this.deps.destination.consumeSignals) {
      throw new Error(
        `Training destination ${this.deps.destination.id} does not accept online learning signals.`,
      );
    }
    await this.deps.destination.consumeSignals(job.id, batch);
    receipts.set(batch.sequence, batch.contentHash);
    await this.deps.store.saveTrainingJob({
      ...job,
      metadata: {
        ...job.metadata,
        portableSignalReceipts: [...receipts]
          .sort(([left], [right]) => left - right)
          .map(([sequence, receiptHash]) => ({
            sequence,
            contentHash: receiptHash,
          })),
      },
    });
  }

  async status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus> {
    return toPortableStatus(await this.deps.destination.status(ref.runId));
  }

  async logs(ref: TrainingExecutionRef, cursor?: string) {
    const events = await this.deps.store.listTrainingJobEvents(ref.runId);
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

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    await this.deps.destination.cancel(ref.runId);
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const [artifacts, job] = await Promise.all([
      this.deps.destination.collect(ref.runId),
      this.deps.destination.status(ref.runId),
    ]);
    const manifestHash = job.metadata.harnessRunManifestHash;
    if (typeof manifestHash !== "string") {
      throw new Error("Training artifacts have no Harness Run Manifest lineage.");
    }
    const base = {
      runId: ref.runId,
      manifestHash,
      artifacts: artifacts.map(toPortableArtifact),
    };
    return { ...base, contentHash: contentHash(base) };
  }

  private async executionContext(plan: ResolvedTrainingPlan) {
    if (!plan.execution) return null;
    const [trainingPlan, approval] = await Promise.all([
      this.deps.store.getTrainingPlan(plan.execution.trainingPlanId),
      this.deps.store.getTrainingApproval(plan.execution.approvalId),
    ]);
    return trainingPlan && approval ? { trainingPlan, approval } : null;
  }
}

function isSignalReceipt(
  value: unknown,
): value is { sequence: number; contentHash: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger(Reflect.get(value, "sequence")) &&
    typeof Reflect.get(value, "contentHash") === "string"
  );
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
  return {
    kind:
      artifact.kind === "log"
        ? "trace"
        : artifact.kind === "manifest"
          ? "receipt"
          : artifact.kind,
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
