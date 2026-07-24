import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  AdapterValidationReceiptSchema,
  type AdapterValidationReceipt,
  type LearningSignalBatch,
  type ResolvedTrainingPlan,
  type TrainingArtifacts,
  type TrainingEngineCapabilities,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type {
  ComputeLease,
  ComputeTargetAdapter,
  TrainingEngineAdapter,
} from "@openpond/training-sdk";

export type ProvisionedConnectedWorkerSession = {
  schemaVersion: "openpond.provisionedConnectedWorkerSession.v1";
  runId: string;
  planHash: string;
  manifestHash: string;
  workerImageDigest: string;
  computeLease: ComputeLease;
  engineRef: TrainingExecutionRef;
  createdAt: string;
};

export interface ProvisionedConnectedWorkerSessionStore {
  save(session: ProvisionedConnectedWorkerSession): Promise<void>;
  load(runId: string): Promise<ProvisionedConnectedWorkerSession | null>;
  remove(runId: string): Promise<void>;
}

export interface ProvisionedConnectedWorkerFactory {
  connect(input: {
    runId: string;
    lease: ComputeLease;
    workerImageDigest: string;
  }): Promise<TrainingEngineAdapter>;
  release?(input: {
    runId: string;
    lease: ComputeLease;
    workerImageDigest: string;
  }): Promise<void>;
}

/**
 * Composes raw provider compute with the generic connected-worker protocol.
 * The provider adapter never sees Harness semantics, and the worker factory
 * never provisions or terminates provider resources.
 */
export class ProvisionedConnectedTrainingEngineAdapter
  implements TrainingEngineAdapter
{
  readonly id: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly compute: ComputeTargetAdapter,
    private readonly workers: ProvisionedConnectedWorkerFactory,
    private readonly sessions: ProvisionedConnectedWorkerSessionStore,
    private readonly capabilitiesProvider: () => Promise<TrainingEngineCapabilities>,
    private readonly options: {
      id?: string;
      leaseDurationMs?: number;
      now?: () => Date;
    } = {},
  ) {
    this.id = options.id ?? "connected-prime-rl";
  }

  capabilities(): Promise<TrainingEngineCapabilities> {
    return this.capabilitiesProvider();
  }

  async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    const issues: AdapterValidationReceipt["issues"] = [];
    if (plan.engine.adapterId !== this.id) {
      issues.push(issue(
        "engine_binding_changed",
        "engine.adapterId",
        `Expected ${this.id}.`,
      ));
    }
    if (plan.compute.adapterId !== this.compute.id) {
      issues.push(issue(
        "compute_binding_changed",
        "compute.adapterId",
        `Expected ${this.compute.id}.`,
      ));
    }
    if (!plan.engine.workerImageDigest) {
      issues.push(issue(
        "worker_image_missing",
        "engine.workerImageDigest",
        "Provisioned connected training requires an immutable worker image digest.",
      ));
    }
    if (plan.maximumSpendUsd === null) {
      issues.push(issue(
        "maximum_spend_missing",
        "maximumSpendUsd",
        "Raw provider compute requires an explicit maximum spend.",
      ));
    }
    const [engineCapabilities, computeCapabilities] = await Promise.all([
      this.capabilities(),
      this.compute.discover(),
    ]);
    if (!engineCapabilities.available) {
      issues.push(issue(
        "engine_unavailable",
        "engine.capabilityReceipt",
        engineCapabilities.unavailableReason ??
          "The connected engine is unavailable.",
      ));
    }
    if (
      !engineCapabilities.methods.includes(plan.recipe.method)
    ) {
      issues.push(issue(
        "method_unsupported",
        "recipe.method",
        `${plan.recipe.method} is not supported by ${this.id}.`,
      ));
    }
    if (
      !computeCapabilities.available ||
      !computeCapabilities.devices.some(
        (device) => device.id === plan.compute.deviceOrPool,
      )
    ) {
      issues.push(issue(
        "compute_unavailable",
        "compute.deviceOrPool",
        computeCapabilities.unavailableReason ??
          `Compute target ${plan.compute.deviceOrPool} is unavailable.`,
      ));
    }
    const base = {
      schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
      adapterId: this.id,
      valid: issues.length === 0,
      issues,
      capabilityReceipt: engineCapabilities.capabilityReceipt,
      planHash: plan.contentHash,
      createdAt: this.now().toISOString(),
    };
    return AdapterValidationReceiptSchema.parse({
      ...base,
      contentHash: contentHash(base),
    });
  }

  launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    return this.exclusive(plan.manifest.id, async () => {
      const existing = await this.sessions.load(plan.manifest.id);
      if (existing) {
        assertSessionLineage(existing, plan.contentHash);
        return this.publicRef(existing);
      }
      const validation = await this.validate(plan);
      if (!validation.valid) {
        throw new Error(
          `Provisioned connected training validation failed: ${validation.issues
            .map((item) => item.message)
            .join("; ")}`,
        );
      }
      const workerImageDigest = plan.engine.workerImageDigest!;
      const deadline = new Date(
        this.now().getTime() +
          (this.options.leaseDurationMs ?? 3_600_000),
      ).toISOString();
      const lease = await this.compute.acquire({
        runId: plan.manifest.id,
        deviceOrPool: plan.compute.deviceOrPool,
        workerImageDigest,
        maximumSpendUsd: plan.maximumSpendUsd,
        deadline,
      });
      try {
        const engine = await this.workers.connect({
          runId: plan.manifest.id,
          lease,
          workerImageDigest,
        });
        const innerValidation = await engine.validate(plan);
        if (!innerValidation.valid) {
          throw new Error(
            `Connected worker rejected the plan: ${innerValidation.issues
              .map((item) => item.message)
              .join("; ")}`,
          );
        }
        const engineRef = await engine.launch(plan);
        if (
          engineRef.runId !== plan.manifest.id ||
          engineRef.adapterId !== this.id
        ) {
          throw new Error(
            "Connected worker changed the canonical run or engine identity.",
          );
        }
        const session: ProvisionedConnectedWorkerSession = {
          schemaVersion:
            "openpond.provisionedConnectedWorkerSession.v1",
          runId: plan.manifest.id,
          planHash: plan.contentHash,
          manifestHash: plan.manifest.contentHash,
          workerImageDigest,
          computeLease: lease,
          engineRef,
          createdAt: this.now().toISOString(),
        };
        await this.sessions.save(session);
        return this.publicRef(session);
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (this.workers.release) {
          await this.workers
            .release({
              runId: plan.manifest.id,
              lease,
              workerImageDigest,
            })
            .catch((cleanupError) =>
              cleanupErrors.push(cleanupError)
            );
        }
        await this.compute
          .release(lease)
          .catch((cleanupError) => cleanupErrors.push(cleanupError));
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Connected training launch and cleanup failed.",
          );
        }
        throw error;
      }
    });
  }

  consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void> {
    return this.withSession(ref, (engine, session) =>
      engine.consumeSignals(session.engineRef, batch)
    );
  }

  status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    return this.withSession(ref, async (engine, session) => {
      const heartbeat = await this.compute.heartbeat(
        session.computeLease,
      );
      if (
        heartbeat.id !== session.computeLease.id ||
        heartbeat.capabilityReceipt !==
          session.computeLease.capabilityReceipt
      ) {
        throw new Error(
          "Provider heartbeat changed the provisioned compute identity.",
        );
      }
      return engine.status(session.engineRef);
    });
  }

  logs(ref: TrainingExecutionRef, cursor?: string) {
    return this.withSession(ref, (engine, session) =>
      engine.logs(session.engineRef, cursor)
    );
  }

  cancel(ref: TrainingExecutionRef): Promise<void> {
    return this.exclusive(ref.runId, async () => {
      const { engine, session } = await this.session(ref);
      let primaryError: unknown = null;
      try {
        await engine.cancel(session.engineRef);
      } catch (error) {
        primaryError = error;
      }
      try {
        await this.releaseResources(session);
      } catch (cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError].filter(Boolean),
          "Connected training cancellation or provider cleanup failed.",
        );
      }
      if (primaryError) throw primaryError;
    });
  }

  collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    return this.exclusive(ref.runId, async () => {
      const { engine, session } = await this.session(ref);
      let artifacts: TrainingArtifacts | null = null;
      let primaryError: unknown = null;
      try {
        artifacts = await engine.collect(session.engineRef);
      } catch (error) {
        primaryError = error;
      }
      if (
        artifacts &&
        artifacts.manifestHash !== session.manifestHash
      ) {
        primaryError = new Error(
          "Connected worker artifacts changed the Harness Run Manifest lineage.",
        );
      }
      try {
        await this.releaseResources(session);
      } catch (cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError].filter(Boolean),
          "Connected training artifact collection or provider cleanup failed.",
        );
      }
      if (primaryError) throw primaryError;
      return artifacts!;
    });
  }

  private async withSession<T>(
    ref: TrainingExecutionRef,
    operation: (
      engine: TrainingEngineAdapter,
      session: ProvisionedConnectedWorkerSession,
    ) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(ref.runId, async () => {
      const { engine, session } = await this.session(ref);
      return operation(engine, session);
    });
  }

  private async session(ref: TrainingExecutionRef): Promise<{
    engine: TrainingEngineAdapter;
    session: ProvisionedConnectedWorkerSession;
  }> {
    const session = await this.sessions.load(ref.runId);
    if (!session) {
      throw new Error(
        `Provisioned connected session ${ref.runId} is unavailable.`,
      );
    }
    if (
      ref.leaseId !== session.computeLease.id ||
      ref.providerJobId !== session.engineRef.providerJobId ||
      (ref.manifestHash !== undefined &&
        ref.manifestHash !== session.manifestHash)
    ) {
      throw new Error(
        "Provisioned connected execution reference changed.",
      );
    }
    const engine = await this.workers.connect({
      runId: session.runId,
      lease: session.computeLease,
      workerImageDigest: session.workerImageDigest,
    });
    return { engine, session };
  }

  private publicRef(
    session: ProvisionedConnectedWorkerSession,
  ): TrainingExecutionRef {
    return {
      runId: session.runId,
      adapterId: this.id,
      providerJobId: session.engineRef.providerJobId,
      leaseId: session.computeLease.id,
      manifestHash: session.manifestHash,
      createdAt: session.engineRef.createdAt,
    };
  }

  private async releaseResources(
    session: ProvisionedConnectedWorkerSession,
  ): Promise<void> {
    const errors: unknown[] = [];
    if (this.workers.release) {
      await this.workers
        .release({
          runId: session.runId,
          lease: session.computeLease,
          workerImageDigest: session.workerImageDigest,
        })
        .catch((error) => errors.push(error));
    }
    let providerReleased = false;
    try {
      await this.compute.release(session.computeLease);
      providerReleased = true;
    } catch (error) {
      errors.push(error);
    }
    if (providerReleased) {
      await this.sessions
        .remove(session.runId)
        .catch((error) => errors.push(error));
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Provisioned connected worker cleanup failed.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async exclusive<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.locks.get(runId) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const tracked = result.finally(() => {
      if (this.locks.get(runId) === tracked) {
        this.locks.delete(runId);
      }
    });
    this.locks.set(runId, tracked);
    return tracked;
  }
}

export class FileProvisionedConnectedWorkerSessionStore
  implements ProvisionedConnectedWorkerSessionStore
{
  constructor(private readonly root: string) {}

  async save(session: ProvisionedConnectedWorkerSession): Promise<void> {
    validateSession(session);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(session.runId);
    const serialized = `${JSON.stringify(session, null, 2)}\n`;
    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing !== null) {
      if (existing !== serialized) {
        throw new Error(
          `Provisioned connected session ${session.runId} changed.`,
        );
      }
      return;
    }
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, serialized, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target).catch(async (error) => {
      await rm(temporary, { force: true });
      const current = await readFile(target, "utf8").catch(() => null);
      if (current !== serialized) throw error;
    });
  }

  async load(
    runId: string,
  ): Promise<ProvisionedConnectedWorkerSession | null> {
    const value = await readFile(this.path(runId), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (value === null) return null;
    const session = JSON.parse(value) as ProvisionedConnectedWorkerSession;
    validateSession(session);
    if (session.runId !== runId) {
      throw new Error("Provisioned connected session path changed.");
    }
    return session;
  }

  async remove(runId: string): Promise<void> {
    await rm(this.path(runId), { force: true });
  }

  private path(runId: string): string {
    return path.join(this.root, `${contentHash(runId)}.json`);
  }
}

function issue(
  code: string,
  path: string,
  message: string,
): AdapterValidationReceipt["issues"][number] {
  return { code, path, message };
}

function assertSessionLineage(
  session: ProvisionedConnectedWorkerSession,
  planHash: string,
): void {
  if (session.planHash !== planHash) {
    throw new Error(
      `Provisioned connected session ${session.runId} changed plans.`,
    );
  }
}

function validateSession(
  session: ProvisionedConnectedWorkerSession,
): void {
  if (
    session.schemaVersion !==
      "openpond.provisionedConnectedWorkerSession.v1" ||
    !session.runId ||
    !/^[a-f0-9]{64}$/.test(session.planHash) ||
    !/^[a-f0-9]{64}$/.test(session.manifestHash) ||
    !/^sha256:[a-f0-9]{64}$/.test(session.workerImageDigest) ||
    session.computeLease.id.length === 0 ||
    session.engineRef.runId.length === 0
  ) {
    throw new Error("Provisioned connected session is invalid.");
  }
}
