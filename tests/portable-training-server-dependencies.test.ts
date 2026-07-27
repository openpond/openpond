import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TrainingAdapterRegistry,
  type HarnessRuntimeAdapter,
  type TrainingEngineAdapter,
} from "@openpond/training-sdk";
import { sha256 } from "@openpond/taskset-sdk";
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
      id: "remote-transport",
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
      id: "remote-runtime",
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
              id: "remote",
              matches: (plan) =>
                plan.runtime.adapterId === "remote-runtime",
              adapter: engine,
            },
          },
        ],
      },
    });

    dependencies.registerPortableAdapters(registry);

    expect(registry.runtimeIds()).toEqual(["remote-runtime"]);
    expect(registry.engineIds()).toEqual(["connected-prime-rl"]);
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
