import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type AdapterValidationReceipt,
  type LearningSignalBatch,
  type ResolvedTrainingPlan,
  type TrainingArtifacts,
  type TrainingEngineCapabilities,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
  type WorkerLease,
  type WorkerResolvedBundle,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { TrainingEngineAdapter } from "@openpond/training-sdk";

import { AuthenticatedConnectedWorker } from "./protocol-client.js";

export class ConnectedTrainingEngineAdapter
  implements TrainingEngineAdapter
{
  readonly id: string;
  private readonly leases = new Map<string, WorkerLease>();
  private readonly manifestHashes = new Map<string, string>();
  private readonly terminalStatuses = new Map<
    string,
    TrainingExecutionStatus
  >();
  private readonly collectedArtifacts = new Map<
    string,
    TrainingArtifacts
  >();

  constructor(
    private readonly worker: AuthenticatedConnectedWorker,
    private readonly options: {
      id: string;
      resolvedBundle(plan: ResolvedTrainingPlan): Promise<WorkerResolvedBundle>;
      artifactDirectory?: string;
      leaseDurationSeconds?: number;
    },
  ) {
    this.id = options.id;
  }

  async capabilities(): Promise<TrainingEngineCapabilities> {
    await this.worker.connect();
    return this.worker.transport.capabilities();
  }

  async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    await this.worker.connect();
    return this.worker.transport.validate(plan);
  }

  async launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    const lease = await this.worker.acquireLease({
      runId: plan.manifest.id,
      durationSeconds: this.options.leaseDurationSeconds ?? 3_600,
    });
    try {
      const resolvedBundle = await this.options.resolvedBundle(plan);
      const ref = await this.worker.transport.launch({
        leaseId: lease.id,
        plan,
        resolvedBundle:
          await this.worker.transport.stageBundle(
            resolvedBundle,
            lease.id,
          ),
      });
      this.leases.set(ref.runId, lease);
      this.manifestHashes.set(
        ref.runId,
        plan.manifest.contentHash,
      );
      return ref;
    } catch (error) {
      await this.worker.transport.releaseLease(lease.id);
      throw error;
    }
  }

  async consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void> {
    await this.worker.transport.sendSignals(ref, batch);
  }

  async status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    const terminal = this.terminalStatuses.get(ref.runId);
    if (terminal) return terminal;
    await this.ensureLease(ref);
    const status = await this.worker.transport.status(ref);
    if (isTerminal(status.state)) {
      rememberBounded(this.terminalStatuses, ref.runId, status);
    }
    return status;
  }

  async logs(ref: TrainingExecutionRef, cursor?: string) {
    return this.worker.transport.logs(ref, cursor);
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    await this.worker.transport.cancel(ref);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await this.status(ref);
      if (isTerminal(status.state)) return;
      await delay(250);
    }
    throw new Error(
      "Connected worker cancellation did not reach a terminal state.",
    );
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const collected = this.collectedArtifacts.get(ref.runId);
    if (collected) return collected;
    const status = await this.status(ref);
    if (!isTerminal(status.state)) {
      throw new Error(
        "Connected worker artifacts are available only after a terminal state.",
      );
    }
    let artifacts = await this.worker.transport.artifacts(ref);
    const expectedManifestHash = this.manifestHashes.get(ref.runId);
    if (
      expectedManifestHash !== undefined &&
      artifacts.manifestHash !== expectedManifestHash
    ) {
      throw new Error(
        "Connected worker artifacts do not match the launched manifest.",
      );
    }
    if (this.options.artifactDirectory) {
      artifacts = await this.collectArtifactsLocally(
        ref,
        artifacts,
        this.options.artifactDirectory,
      );
    }
    rememberBounded(this.collectedArtifacts, ref.runId, artifacts);
    const lease = this.leases.get(ref.runId);
    if (lease) {
      await this.worker.transport.releaseLease(lease.id);
      this.leases.delete(ref.runId);
      this.manifestHashes.delete(ref.runId);
    }
    return artifacts;
  }

  private async collectArtifactsLocally(
    ref: TrainingExecutionRef,
    remote: TrainingArtifacts,
    root: string,
  ): Promise<TrainingArtifacts> {
    const runDirectory = path.join(
      root,
      createHash("sha256").update(ref.runId).digest("hex"),
    );
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const artifacts: TrainingArtifacts["artifacts"] = [];
    for (const [index, artifact] of remote.artifacts.entries()) {
      const destination = path.join(
        runDirectory,
        `${index}-${artifact.kind}-${artifact.sha256}.bin`,
      );
      if (await verifiedExistingArtifact(destination, artifact)) {
        artifacts.push({
          ...artifact,
          objectRef: pathToFileURL(destination).toString(),
        });
        continue;
      }
      const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
      const file = await open(temporary, "wx", 0o600);
      const digest = createHash("sha256");
      let offset = 0;
      try {
        try {
          while (true) {
            const chunk = await this.worker.transport.downloadArtifact({
              ref,
              objectRef: artifact.objectRef,
              offset,
            });
            if (chunk.offset !== offset) {
              throw new Error(
                "Connected worker artifact chunk offset changed.",
              );
            }
            const bytes = Buffer.from(chunk.bytesBase64, "base64");
            if (
              createHash("sha256").update(bytes).digest("hex") !==
                chunk.chunkHash ||
              (!chunk.final && bytes.byteLength === 0) ||
              offset + bytes.byteLength > artifact.sizeBytes
            ) {
              throw new Error(
                "Connected worker artifact chunk failed verification.",
              );
            }
            await file.write(bytes, 0, bytes.byteLength, offset);
            digest.update(bytes);
            offset += bytes.byteLength;
            if (chunk.final) break;
          }
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      if (
        offset !== artifact.sizeBytes ||
        digest.digest("hex") !== artifact.sha256
      ) {
        await rm(temporary, { force: true });
        throw new Error(
          "Connected worker artifact failed final hash or size verification.",
        );
      }
      await rename(temporary, destination).catch(async (error) => {
        if (!(await verifiedExistingArtifact(destination, artifact))) {
          await rm(temporary, { force: true });
          throw error;
        }
        await rm(temporary, { force: true });
      });
      artifacts.push({
        ...artifact,
        objectRef: pathToFileURL(destination).toString(),
      });
    }
    const base = {
      runId: remote.runId,
      manifestHash: remote.manifestHash,
      artifacts,
    };
    return { ...base, contentHash: contentHash(base) };
  }

  private async ensureLease(
    ref: TrainingExecutionRef,
  ): Promise<WorkerLease> {
    const known = this.leases.get(ref.runId);
    if (known) {
      const heartbeat = await this.worker.heartbeat(known);
      this.leases.set(ref.runId, heartbeat);
      return heartbeat;
    }
    if (ref.leaseId) {
      try {
        const heartbeat =
          await this.worker.transport.heartbeat(ref.leaseId);
        this.leases.set(ref.runId, heartbeat);
        return heartbeat;
      } catch {
        // The worker may have restarted; reacquire the same run-scoped lease.
      }
    }
    const recovered = await this.worker.acquireLease({
      runId: ref.runId,
      durationSeconds: this.options.leaseDurationSeconds ?? 3_600,
    });
    this.leases.set(ref.runId, recovered);
    return recovered;
  }
}

function isTerminal(
  state: TrainingExecutionStatus["state"],
): boolean {
  return (
    state === "cancelled" ||
    state === "succeeded" ||
    state === "failed"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifiedExistingArtifact(
  file: string,
  expected: TrainingArtifacts["artifacts"][number],
): Promise<boolean> {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size !== expected.sizeBytes) {
      return false;
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) {
      digest.update(chunk);
    }
    return digest.digest("hex") === expected.sha256;
  } catch {
    return false;
  }
}

function rememberBounded<K, V>(
  values: Map<K, V>,
  key: K,
  value: V,
): void {
  if (!values.has(key) && values.size >= 1_000) {
    const oldest = values.keys().next().value as K | undefined;
    if (oldest !== undefined) values.delete(oldest);
  }
  values.set(key, value);
}
