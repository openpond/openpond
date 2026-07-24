import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TrainingAdapterRegistry,
  type HarnessRuntimeAdapter,
  type TrainingEngineAdapter,
} from "@openpond/training-sdk";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

import { createPortableTrainingServerDependencies } from "../apps/server/src/training/portable-training-server-dependencies.js";

describe("portable training server composition", () => {
  test("registers the concrete local compute targets used by the catalog", async () => {
    const registry = new TrainingAdapterRegistry();
    const dependencies = createPortableTrainingServerDependencies({
      storeDir: "/tmp/openpond-portable-training-test",
      environment: {},
      computeInventory: async () => null,
    });

    dependencies.registerPortableAdapters(registry);

    expect(registry.computeTargetIds()).toEqual([
      "local-cpu",
      "local-cuda",
      "local-mlx",
    ]);
    await expect(
      registry.computeTarget("local-cpu").discover(),
    ).resolves.toMatchObject({
      adapterId: "local-cpu",
      available: true,
      devices: [{ id: "cpu", runtime: "cpu" }],
    });
    await expect(
      registry.computeTarget("local-cuda").discover(),
    ).resolves.toMatchObject({
      adapterId: "local-cuda",
      available: false,
      devices: [],
    });
    expect(registry.engineIds()).toEqual([]);
  });

  test("composes injected compute, runtime, and routed engine packages", async () => {
    const registry = new TrainingAdapterRegistry();
    const engine = {
      id: "sandbox-transport",
      capabilities: vi.fn(),
      validate: vi.fn(),
      launch: vi.fn(),
      consumeSignals: vi.fn(),
      status: vi.fn(),
      logs: vi.fn(),
      cancel: vi.fn(),
      collect: vi.fn(),
    } satisfies TrainingEngineAdapter;
    const runtime = {
      id: "sandbox-latitude",
      capabilities: vi.fn(),
      materialize: vi.fn(),
      create: vi.fn(),
      reset: vi.fn(),
      step: vi.fn(),
      grade: vi.fn(),
      collect: vi.fn(),
      destroy: vi.fn(),
    } satisfies HarnessRuntimeAdapter;
    const dependencies = createPortableTrainingServerDependencies({
      storeDir: "/tmp/openpond-portable-training-test",
      environment: {},
      adapters: {
        runtimes: [runtime],
        engineRoutes: [
          {
            canonicalEngineId: "connected-prime-rl",
            route: {
              id: "sandbox",
              matches: (plan) =>
                plan.runtime.adapterId === "sandbox-latitude",
              adapter: engine,
            },
          },
        ],
      },
    });

    dependencies.registerPortableAdapters(registry);

    expect(registry.runtimeIds()).toEqual(["sandbox-latitude"]);
    expect(registry.engineIds()).toEqual(["connected-prime-rl"]);
  });

  test("enables only an exact all-or-nothing Sandbox M8 composition", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-sandbox-m8-config-"),
    );
    const tokenFile = path.join(directory, "service-token");
    const compositionFile = path.join(directory, "composition.json");
    const environmentAsset = {
      schemaVersion: "openpond.managedRftEnvironment.v1",
      packageId: "cross-system-operations",
    };
    const environmentHash = contentHash(environmentAsset);
    await writeFile(tokenFile, "opsvc_fixture.signature\n", {
      mode: 0o600,
    });
    await writeFile(
      compositionFile,
      JSON.stringify({
        schemaVersion: "openpond.sandboxM8Composition.v1",
        environmentAsset: {
          value: environmentAsset,
          expectedSha256: environmentHash,
        },
        runtime: {
          adapterId: "sandbox-latitude",
          placement: "remote",
          capabilityReceipt: sha256("sandbox-runtime"),
          runtimeVersion: "verifiers-v1",
          dataPlane: {
            provider: "latitude",
            dataPlaneId: "openpond-latitude-staging",
            cellId: "openpond-latitude-staging-k8s",
            runnerPoolId: "openpond-latitude-staging-k8s:default",
            runtimeImageDigest: `sha256:${sha256("runtime-image")}`,
            capabilityReceipt: sha256("placement"),
          },
        },
        compute: {
          adapterId: "prime-raw",
          kind: "managed",
          deviceOrPool: "gpu_1x_h100_sxm5",
          capabilityReceipt: sha256("prime-capability"),
          provider: "prime",
        },
        expectedEngine: {
          workerImageDigest: `sha256:${sha256("worker-image")}`,
          upstreamRevision: "e0d60e4d85ea636873acb2e7083e794740d20226",
          capabilityReceipt: sha256("engine-capability"),
        },
        inputBundleTemplate:
          sandboxM8InputTemplate(environmentHash),
      }),
    );
    try {
      const registry = new TrainingAdapterRegistry();
      const dependencies = createPortableTrainingServerDependencies({
        storeDir: directory,
        environment: {
          OPENPOND_SANDBOX_M8_URL: "https://sandbox.test",
          OPENPOND_SANDBOX_M8_AUTH_TOKEN_FILE: tokenFile,
          OPENPOND_SANDBOX_M8_COMPOSITION_FILE: compositionFile,
        },
      });
      dependencies.registerPortableAdapters(registry);

      expect(dependencies.sandboxManagedConfigured).toBe(true);
      expect(dependencies.connectedWorkerImageDigest).toBe(
        `sha256:${sha256("worker-image")}`,
      );
      expect(dependencies.sandboxBinding).toMatchObject({
        resolvedBundleHash: environmentHash,
        runtime: { adapterId: "sandbox-latitude" },
        compute: {
          adapterId: "prime-raw",
          deviceOrPool: "gpu_1x_h100_sxm5",
        },
      });
      expect(registry.engineIds()).toEqual([
        "connected-prime-rl",
      ]);
      await expect(
        registry.engine("connected-prime-rl").capabilities(),
      ).resolves.toMatchObject({
        available: true,
        methods: ["grpo"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects partial Sandbox M8 configuration", () => {
    expect(() =>
      createPortableTrainingServerDependencies({
        storeDir: "/tmp/openpond-portable-training-test",
        environment: {
          OPENPOND_SANDBOX_M8_URL: "https://sandbox.test",
        },
      }),
    ).toThrow(/requires URL, auth-token file, and composition file/);
  });

  test("composes raw Prime compute with the generic provisioned worker route", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-prime-raw-config-"),
    );
    const privateFiles = await Promise.all(
      [
        "api-key",
        "ssh-key",
        "authentication-lease",
        "registry-auth",
        "identity-key",
        "worker-tls-key",
        "client-tls-key",
      ].map(async (name) => {
        const file = path.join(directory, name);
        await writeFile(file, `${name}-fixture\n`, { mode: 0o600 });
        return file;
      }),
    );
    const publicFiles = await Promise.all(
      ["worker-tls-cert", "worker-client-ca", "client-cert", "server-ca"].map(
        async (name) => {
          const file = path.join(directory, name);
          await writeFile(file, `${name}-fixture\n`);
          return file;
        },
      ),
    );
    try {
      const registry = new TrainingAdapterRegistry();
      const dependencies = createPortableTrainingServerDependencies({
        storeDir: directory,
        environment: {
          OPENPOND_PRIME_API_KEY_FILE: privateFiles[0],
          OPENPOND_PRIME_SSH_KEY_ID: "prime-ssh-key",
          OPENPOND_PRIME_SSH_PRIVATE_KEY_FILE: privateFiles[1],
          OPENPOND_PRIME_WORKER_TEMPLATE_ID: "immutable-template",
          OPENPOND_PRIME_WORKER_IMAGE_REPOSITORY:
            "registry.example/openpond-worker",
          OPENPOND_PRIME_WORKER_IMAGE_DIGEST:
            `sha256:${sha256("worker-image")}`,
          OPENPOND_PRIME_WORKER_CAPABILITY_RECEIPT:
            sha256("worker-capability"),
          OPENPOND_PRIME_WORKER_AUTHENTICATION_LEASE_FILE:
            privateFiles[2],
          OPENPOND_PRIME_WORKER_REGISTRY_AUTH_FILE:
            privateFiles[3],
          OPENPOND_PRIME_WORKER_IDENTITY_KEY_FILE:
            privateFiles[4],
          OPENPOND_PRIME_WORKER_TLS_CERTIFICATE_FILE:
            publicFiles[0],
          OPENPOND_PRIME_WORKER_TLS_PRIVATE_KEY_FILE:
            privateFiles[5],
          OPENPOND_PRIME_WORKER_CLIENT_CA_FILE: publicFiles[1],
          OPENPOND_PRIME_CLIENT_CERTIFICATE_FILE: publicFiles[2],
          OPENPOND_PRIME_CLIENT_PRIVATE_KEY_FILE: privateFiles[6],
          OPENPOND_PRIME_SERVER_CA_FILE: publicFiles[3],
          OPENPOND_PRIME_TLS_SERVER_NAME: "openpond-worker",
        },
      });
      dependencies.registerPortableAdapters(registry);

      expect(dependencies.primeRawConfigured).toBe(true);
      expect(dependencies.connectedWorkerImageDigest).toBe(
        `sha256:${sha256("worker-image")}`,
      );
      expect(registry.computeTargetIds()).toContain("prime-raw");
      expect(registry.engineIds()).toEqual([
        "connected-prime-rl",
      ]);
      await expect(
        registry.engine("connected-prime-rl").capabilities(),
      ).resolves.toMatchObject({
        available: true,
        upstreamRevision:
          "e0d60e4d85ea636873acb2e7083e794740d20226",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects partial raw Prime configuration", () => {
    expect(() =>
      createPortableTrainingServerDependencies({
        storeDir: "/tmp/openpond-portable-training-test",
        environment: {
          OPENPOND_PRIME_SSH_KEY_ID: "partial",
        },
      }),
    ).toThrow(/requires provider, SSH, worker image/);
  });
});

function sandboxM8InputTemplate(environmentHash: string) {
  const hash = (label: string) => sha256(label);
  return {
    profileSnapshot: {
      projectId: "project-1",
      profileId: "cross-system-operations",
      sourceRef: "refs/heads/main",
      sourceCommitSha: "a".repeat(40),
      manifestHash: hash("profile-manifest"),
      manifestPath: "openpond.yaml",
      publishedSnapshotId: "snapshot-1",
      validationAttestationSha256: hash("validation"),
      published: true,
      mutable: false,
    },
    taskset: {
      id: "cross-system-operations",
      revision: 1,
      contentHash: hash("taskset"),
      trainSplitHash: hash("train"),
      validationSplitHash: hash("validation-split"),
      frozenEvalHash: hash("frozen-eval"),
      taskCount: 8,
    },
    materialization: {
      environmentArchive: {
        schemaVersion: "openpond.harnessEnvironmentArchive.v1",
        sha256: environmentHash,
        sizeBytes: 1_024,
        dependencyLockSha256: hash("dependencies"),
        worldSha256: hash("world"),
        toolSchemaSha256: hash("tools"),
        rewardSha256: hash("reward"),
        rendererSha256: hash("renderer"),
      },
    },
    baseModel: {
      source: "huggingface",
      repoId: "Qwen/Qwen3-4B-Instruct-2507",
      revision: "b".repeat(40),
      configHash: hash("model-config"),
      tokenizerHash: hash("tokenizer"),
      licenseId: "apache-2.0",
      gated: false,
    },
    connectedGpu: {
      shape: "H100_80GB",
      maxHourlyUsd: "5.000000",
    },
    limits: {
      maxTotalUsd: "9.000000",
      maxGpuUsd: "6.500000",
      maxSandboxUsd: "1.500000",
      maxStorageUsd: "0.500000",
      cleanupReserveUsd: "0.500000",
      maxGpuSeconds: 1_800,
      maxSandboxSeconds: 28_800,
      maxWallSeconds: 2_400,
      maxRolloutWorkers: 4,
      maxActiveRollouts: 4,
      maxRollouts: 8,
      maxRetries: 4,
      maxTasks: 8,
      maxTurns: 64,
      maxToolCalls: 128,
      maxModelCalls: 128,
      maxPromptTokens: 250_000,
      maxOutputTokens: 250_000,
      maxTrajectoryBytes: 16 * 1_024 * 1_024,
      maxCheckpoints: 3,
      maxCheckpointBytes: 16 * 1_024 * 1_024 * 1_024,
      maxArtifactBytes: 8 * 1_024 * 1_024 * 1_024,
      warmupDeadlineSeconds: 900,
      rolloutDeadlineSeconds: 600,
      trainerStepDeadlineSeconds: 600,
      uploadDeadlineSeconds: 600,
      cancellationDeadlineSeconds: 300,
    },
  };
}
