import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AdapterValidationReceipt,
  LearningSignalBatch,
  ResolvedTrainingPlan,
  TrainingArtifacts,
  TrainingEngineCapabilities,
  TrainingExecutionRef,
  TrainingExecutionStatus,
  WorkerLease,
} from "@openpond/contracts";
import {
  LocalComputeTargetAdapter,
  LocalTrainingEngineAdapter,
  type LocalEngineWorker,
} from "../packages/trainer-local/src/index.js";
import {
  AuthenticatedConnectedWorker,
  ConnectedTrainingEngineAdapter,
  FileProvisionedConnectedWorkerSessionStore,
  ProvisionedConnectedTrainingEngineAdapter,
  type ConnectedWorkerTransport,
} from "../packages/trainer-connected/src/index.js";
import {
  FireworksTrainingEngineAdapter,
  type FireworksManagedTrainingClient,
} from "../packages/trainer-fireworks/src/index.js";
import { PrimeComputeTargetAdapter } from "../packages/compute-provider-prime/src/index.js";
import {
  RoutedTrainingEngineAdapter,
  runComputeAdapterConformance,
  runEngineAdapterConformance,
} from "@openpond/training-sdk";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

import {
  createManifestFixture,
  fixtureTimestamp,
} from "./helpers/portable-training-fixtures.js";
import { sftRecipeFixture } from "./helpers/training-fixtures.js";

describe("trainer package conformance", () => {
  test("local and authenticated connected engines pass one contract", async () => {
    const artifactDirectory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-connected-artifacts-"),
    );
    try {
      const localWorker = engineWorker("local-test");
      const local = new LocalTrainingEngineAdapter(
        localWorker,
        "local-test",
      );
      const connectedTransport =
        connectedWorkerTransport("connected-test");
      const connected = new ConnectedTrainingEngineAdapter(
        new AuthenticatedConnectedWorker(
          connectedTransport,
          { verifyNonce: async () => true },
          {
            clientRelease: "0.0.38",
            expectedWorkerImageDigest: `sha256:${sha256("worker-image")}`,
            secretLeaseRef: "secret-lease-fixture",
            nonce: () => "nonce-0123456789abcdef",
          },
        ),
        {
          id: "connected-test",
          artifactDirectory,
          resolvedBundle: async () => ({
            objectRef: "https://artifacts.test/bundles/fixture.tar",
            bundleContentHash: sha256("bundle-content"),
            sha256: sha256("bundle"),
            sizeBytes: 1_024,
            format: "tar",
          }),
        },
      );

      const [localResult, connectedResult] = await Promise.all([
        runEngineAdapterConformance({
          adapter: local,
          plan: plan("local-test"),
          signals: signalBatch(),
        }),
        runEngineAdapterConformance({
          adapter: connected,
          plan: plan("connected-test"),
          signals: signalBatch(),
        }),
      ]);

      expect(localResult.passed).toBe(true);
      expect(connectedResult.passed).toBe(true);
      expect(connectedTransport.sendSignals).toHaveBeenCalledTimes(1);
      expect(connectedTransport.releaseLease).toHaveBeenCalledTimes(1);
      expect(
        await readdir(
          path.join(
            artifactDirectory,
            sha256(createManifestFixture().id),
          ),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });

  test("the Fireworks package consumes the same canonical signal batch", async () => {
    const client = managedClient("fireworks");
    const adapter = new FireworksTrainingEngineAdapter(client);
    const result = await runEngineAdapterConformance({
      adapter,
      plan: plan("fireworks"),
      signals: signalBatch(),
    });

    expect(result.passed).toBe(true);
    expect(client.uploadSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestHash: signalBatch().manifestHash,
      }),
    );
  });

  test("persists the selected engine route for later lifecycle calls", async () => {
    const primaryWorker = engineWorker("connected-prime-rl");
    const secondaryWorker = engineWorker("connected-prime-rl");
    const primaryStatus = vi.spyOn(primaryWorker, "status");
    const secondaryStatus = vi.spyOn(secondaryWorker, "status");
    const routed = new RoutedTrainingEngineAdapter(
      "connected-prime-rl",
      [
        {
          id: "sandbox",
          matches: (resolved) =>
            resolved.runtime.adapterId === "sandbox-latitude",
          adapter: new LocalTrainingEngineAdapter(
            secondaryWorker,
            "connected-prime-rl",
          ),
        },
        {
          id: "connected",
          matches: (resolved) =>
            resolved.runtime.adapterId !== "sandbox-latitude",
          adapter: new LocalTrainingEngineAdapter(
            primaryWorker,
            "connected-prime-rl",
          ),
        },
      ],
    );

    const ref = await routed.launch(plan("connected-prime-rl"));
    expect(ref.routeId).toBe("connected");
    await routed.status(ref);
    expect(primaryStatus).toHaveBeenCalledTimes(1);
    expect(secondaryStatus).not.toHaveBeenCalled();
    await expect(
      Promise.resolve().then(() =>
        routed.status({ ...ref, routeId: undefined })
      ),
    ).rejects.toThrow("no persisted engine route");
  });

  test("local and raw Prime compute pass one provider-neutral contract", async () => {
    const deadline = "2026-07-23T13:00:00.000Z";
    const request = {
      runId: "run-compute",
      deviceOrPool: "gpu-0",
      workerImageDigest: `sha256:${sha256("worker-image")}`,
      maximumSpendUsd: 2,
      deadline,
    };
    const local = new LocalComputeTargetAdapter({
      discover: async () => ({
        devices: [device()],
        workerImagesSupported: true,
        capabilityReceipt: sha256("local-compute"),
        checkedAt: fixtureTimestamp,
      }),
    });
    const terminate = vi.fn(async () => undefined);
    const prime = new PrimeComputeTargetAdapter({
      inventory: async () => ({
        devices: [device()],
        capabilityReceipt: sha256("prime-compute"),
        checkedAt: fixtureTimestamp,
      }),
      quote: async () => ({
        quoteId: "quote-1",
        estimatedCostUsd: 1,
        hourlyCostUsd: 2,
        expiresAt: deadline,
        assumptions: ["one raw GPU"],
      }),
      provision: async () => ({
        nodeId: "prime-node-1",
        host: "gpu.example.test",
        port: 22,
        user: "openpond",
        sshHostFingerprint: "SHA256:fixture",
        acquiredAt: fixtureTimestamp,
        expiresAt: deadline,
        capabilityReceipt: sha256("prime-compute"),
      }),
      heartbeat: async () => ({ expiresAt: deadline }),
      terminate,
    });

    const [localResult, primeResult] = await Promise.all([
      runComputeAdapterConformance({
        adapter: local,
        request: { ...request, deviceOrPool: "gpu-0" },
      }),
      runComputeAdapterConformance({ adapter: prime, request }),
    ]);

    expect(localResult.passed).toBe(true);
    expect(primeResult.passed).toBe(true);
    expect(terminate).toHaveBeenCalledWith("prime-node-1");
  });

  test("persists raw Prime compute and connected-worker lifecycle across adapter restarts", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-provisioned-worker-"),
    );
    const resolved = provisionedPlan();
    const terminate = vi.fn(async () => undefined);
    const compute = new PrimeComputeTargetAdapter({
      inventory: async () => ({
        devices: [device()],
        capabilityReceipt: sha256("prime-compute"),
        checkedAt: fixtureTimestamp,
      }),
      quote: async () => ({
        quoteId: "quote-1",
        estimatedCostUsd: 1,
        hourlyCostUsd: 2,
        expiresAt: "2026-07-23T13:00:00.000Z",
        assumptions: ["one raw GPU"],
      }),
      provision: async () => ({
        nodeId: "prime-node-1",
        host: "gpu.example.test",
        port: 22,
        user: "openpond",
        sshHostFingerprint: "SHA256:fixture",
        acquiredAt: fixtureTimestamp,
        expiresAt: "2026-07-23T13:00:00.000Z",
        capabilityReceipt: sha256("prime-compute"),
      }),
      heartbeat: async () => ({
        expiresAt: "2026-07-23T13:00:00.000Z",
      }),
      terminate,
    });
    const sessions =
      new FileProvisionedConnectedWorkerSessionStore(directory);
    const releaseWorker = vi.fn(async () => undefined);
    let failCollection = false;
    const connect = vi.fn(async () =>
      new LocalTrainingEngineAdapter(
        {
          ...engineWorker("connected-prime-rl"),
          collect: async (ref) => {
            if (failCollection) {
              throw new Error("fixture artifact transfer failed");
            }
            return artifacts(ref, resolved.manifest.contentHash);
          },
        },
        "connected-prime-rl",
      )
    );
    const create = () =>
      new ProvisionedConnectedTrainingEngineAdapter(
        compute,
        { connect, release: releaseWorker },
        sessions,
        async () => capabilities("connected-prime-rl"),
        {
          now: () => new Date(fixtureTimestamp),
        },
      );

    try {
      const ref = await create().launch(resolved);
      expect(ref).toMatchObject({
        runId: resolved.manifest.id,
        adapterId: "connected-prime-rl",
        leaseId: "prime-node-1",
      });
      await expect(create().status(ref)).resolves.toMatchObject({
        runId: resolved.manifest.id,
        state: "running",
      });
      await expect(create().collect(ref)).resolves.toMatchObject({
        manifestHash: resolved.manifest.contentHash,
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(releaseWorker).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
      expect(connect).toHaveBeenCalledTimes(3);

      failCollection = true;
      const failedRef = await create().launch(resolved);
      await expect(create().collect(failedRef)).rejects.toThrow(
        "fixture artifact transfer failed",
      );
      expect(terminate).toHaveBeenCalledTimes(2);
      expect(releaseWorker).toHaveBeenCalledTimes(2);
      expect(await readdir(directory)).toEqual([]);
      expect(connect).toHaveBeenCalledTimes(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function plan(adapterId: string): ResolvedTrainingPlan {
  const recipe = sftRecipeFixture();
  const manifest = createManifestFixture({
    method: recipe.method,
    recipeConfigHash: contentHash(recipe),
    engineAdapterId: adapterId,
  });
  const base = {
    schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
    manifest,
    recipe,
    runtime: manifest.runtimeTarget,
    compute: manifest.computeTarget,
    engine: manifest.engine,
    maximumSpendUsd: manifest.approval.maximumSpendUsd,
    approvalHash: manifest.approval.approvalHash,
  };
  return { ...base, contentHash: contentHash(base) };
}

function provisionedPlan(): ResolvedTrainingPlan {
  const recipe = sftRecipeFixture();
  const manifest = createManifestFixture({
    method: recipe.method,
    recipeConfigHash: contentHash(recipe),
    maximumSpendUsd: 2,
    engineAdapterId: "connected-prime-rl",
    computeAdapterId: "prime-raw",
    computeDeviceOrPool: "gpu-0",
    computeKind: "managed",
    computeProvider: "prime",
    workerImageDigest: `sha256:${sha256("worker-image")}`,
  });
  const base = {
    schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
    manifest,
    recipe,
    runtime: manifest.runtimeTarget,
    compute: manifest.computeTarget,
    engine: manifest.engine,
    maximumSpendUsd: manifest.approval.maximumSpendUsd,
    approvalHash: manifest.approval.approvalHash,
  };
  return { ...base, contentHash: contentHash(base) };
}

function signalBatch(): LearningSignalBatch {
  const manifest = createManifestFixture();
  const lineage = {
    datasetRelease: manifest.datasetRelease,
    harnessRelease: manifest.harnessRelease,
    evidenceSetRelease: null,
    profileRelease: null,
    model: {
      source: manifest.model.source,
      revision: manifest.model.revision,
      artifactHash: manifest.model.artifactHash,
    },
    environmentHash: sha256("environment"),
    graderHash: sha256("grader"),
    toolContractHash: sha256("tools"),
    verificationReceiptHash: sha256("verified"),
  };
  const signalBase = {
    schemaVersion: "openpond.learningSignal.v1" as const,
    id: "signal-demo-1",
    taskId: "task-1",
    episodeId: manifest.id,
    policyVersion: null,
    lineage,
    approved: true,
    verifier: "deterministic" as const,
    createdAt: fixtureTimestamp,
    metadata: {},
    kind: "demonstration" as const,
    payload: { prompt: "2+2", response: "4" },
  };
  const signal = { ...signalBase, contentHash: contentHash(signalBase) };
  const base = {
    schemaVersion: "openpond.learningSignalBatch.v1" as const,
    manifestId: manifest.id,
    manifestHash: manifest.contentHash,
    sequence: 0,
    signals: [signal],
  };
  return { ...base, contentHash: contentHash(base) };
}

function capabilities(adapterId: string): TrainingEngineCapabilities {
  return {
    schemaVersion: "openpond.trainingEngineCapabilities.v1",
    adapterId,
    available: true,
    methods: ["sft", "dpo", "ppo", "grpo"],
    signalKinds: ["demonstration", "preference", "trajectory", "reward"],
    modelFamilies: ["transformers"],
    precisions: ["fp32"],
    topologies: ["single_worker"],
    workerProtocolVersion: "openpond.connectedWorker.v1",
    upstreamRevision: "fixture",
    capabilityReceipt: sha256(`${adapterId}-capability`),
    checkedAt: fixtureTimestamp,
    unavailableReason: null,
  };
}

function validation(
  adapterId: string,
  resolved: ResolvedTrainingPlan,
): AdapterValidationReceipt {
  const base = {
    schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
    adapterId,
    valid: true,
    issues: [],
    capabilityReceipt: sha256(`${adapterId}-capability`),
    planHash: resolved.contentHash,
    createdAt: fixtureTimestamp,
  };
  return { ...base, contentHash: contentHash(base) };
}

function execution(adapterId: string): TrainingExecutionRef {
  return {
    runId: createManifestFixture().id,
    adapterId,
    providerJobId: null,
    leaseId: null,
    createdAt: fixtureTimestamp,
  };
}

function status(ref: TrainingExecutionRef): TrainingExecutionStatus {
  return {
    runId: ref.runId,
    state: "running",
    phase: "fixture",
    progress: 0.5,
    updatedAt: fixtureTimestamp,
    errorCode: null,
  };
}

function artifacts(
  ref: TrainingExecutionRef,
  manifestHash = createManifestFixture().contentHash,
): TrainingArtifacts {
  const base = {
    runId: ref.runId,
    manifestHash,
    artifacts: [
      {
        kind: "metrics" as const,
        objectRef: "r2://artifacts/metrics.json",
        sha256: sha256("metrics"),
        sizeBytes: 7,
      },
    ],
  };
  return { ...base, contentHash: contentHash(base) };
}

function engineWorker(adapterId: string): LocalEngineWorker {
  return {
    capabilities: async () => capabilities(adapterId),
    validate: async (resolved) => validation(adapterId, resolved),
    launch: async () => execution(adapterId),
    consumeSignals: async () => undefined,
    status: async (ref) => status(ref),
    logs: async () => ({ cursor: "0", entries: [] }),
    cancel: async () => undefined,
    collect: async (ref) => artifacts(ref),
  };
}

function connectedWorkerTransport(
  adapterId: string,
): ConnectedWorkerTransport & {
  sendSignals: ReturnType<typeof vi.fn>;
  releaseLease: ReturnType<typeof vi.fn>;
} {
  let cancelled = false;
  let launchedManifestHash = createManifestFixture().contentHash;
  const lease: WorkerLease = {
    schemaVersion: "openpond.workerLease.v1",
    id: "lease-1",
    workerId: "worker-1",
    acquiredAt: fixtureTimestamp,
    expiresAt: "2026-07-23T13:00:00.000Z",
    heartbeatAfterSeconds: 30,
    capabilityReceipt: sha256("worker"),
  };
  return {
    handshake: async () => ({
      protocolVersion: "openpond.connectedWorker.v1",
      workerId: "worker-1",
      workerRelease: "0.0.1",
      workerImageDigest: `sha256:${sha256("worker-image")}`,
      nonceSignature: "signed-nonce-fixture-0123456789abcdef",
      capabilityReceipt: sha256("worker"),
      serverTime: fixtureTimestamp,
    }),
    acquireLease: async () => lease,
    heartbeat: async () => lease,
    capabilities: async () => capabilities(adapterId),
    stageBundle: async (bundle) => bundle,
    validate: async (resolved) => validation(adapterId, resolved),
    launch: async (input) => {
      launchedManifestHash = input.plan.manifest.contentHash;
      return { ...execution(adapterId), leaseId: lease.id };
    },
    sendSignals: vi.fn(async () => undefined),
    status: async (ref) => ({
      ...status(ref),
      state: cancelled ? ("cancelled" as const) : "running",
      phase: cancelled ? "cancelled" : "fixture",
    }),
    events: async () => [],
    logs: async () => ({ cursor: "0", entries: [] }),
    cancel: async () => {
      cancelled = true;
    },
    artifacts: async (ref) => artifacts(ref, launchedManifestHash),
    downloadArtifact: async (input) => ({
      runId: input.ref.runId,
      objectRef: input.objectRef,
      offset: input.offset,
      bytesBase64: Buffer.from("metrics").toString("base64"),
      chunkHash: sha256("metrics"),
      final: true,
    }),
    releaseLease: vi.fn(async () => undefined),
  };
}

function managedClient(adapterId: string): FireworksManagedTrainingClient & {
  uploadSignals: ReturnType<typeof vi.fn>;
} {
  return {
    capabilities: async () => capabilities(adapterId),
    validate: async (resolved) => validation(adapterId, resolved),
    uploadSignals: vi.fn(async () => ({
      datasetId: "dataset-1",
      immutableRevision: "revision-1",
    })),
    launch: async () => execution(adapterId),
    status: async (ref) => status(ref),
    logs: async () => ({ cursor: "0", entries: [] }),
    cancel: async () => undefined,
    collect: async (ref) => artifacts(ref),
  };
}

function device() {
  return {
    id: "gpu-0",
    kind: "gpu" as const,
    vendor: "nvidia",
    name: "Fixture GPU",
    memoryBytes: 80_000_000_000,
    runtime: "cuda",
  };
}
