import type {
  HarnessGraderEvidence,
  HarnessRunManifest,
  ModelAction,
  ToolObservation,
} from "@openpond/contracts";
import {
  LocalHarnessRuntimeAdapter,
  type LocalHarnessRuntimeDriver,
} from "../packages/trainer-local/src/index.js";
import {
  SandboxHarnessRuntimeAdapter,
  type SandboxHarnessRuntimeClient,
} from "../packages/trainer-sandbox/src/index.js";
import {
  createHarnessRunManifest,
  runRuntimeAdapterConformance,
} from "@openpond/training-sdk";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

import {
  createHarnessFixture,
  createManifestFixture,
  fixtureTimestamp,
} from "./helpers/portable-training-fixtures.js";

describe("harness runtime adapter conformance", () => {
  test("local and Sandbox runtimes preserve one lifecycle contract", async () => {
    const release = createHarnessFixture().release;
    const localDriver = driver();
    const sandboxClient = driver();
    const local = new LocalHarnessRuntimeAdapter(
      localDriver,
      async () => capabilities("local-harness", ["local"]),
    );
    const sandbox = new SandboxHarnessRuntimeAdapter({
      ...sandboxClient,
      capabilities: async () =>
        capabilities("sandbox-latitude", ["remote"]),
      uploadAndMaterialize: sandboxClient.materialize,
      create: async ({ manifest }) => sandboxClient.create(manifest),
    } satisfies SandboxHarnessRuntimeClient);

    const [localResult, sandboxResult] = await Promise.all([
      runRuntimeAdapterConformance({
        adapter: local,
        release,
        manifest: localManifest(release.contentHash),
        action: action(),
      }),
      runRuntimeAdapterConformance({
        adapter: sandbox,
        release,
        manifest: sandboxManifest(release.contentHash),
        action: action(),
      }),
    ]);

    expect(localResult.passed).toBe(true);
    expect(sandboxResult.passed).toBe(true);
    expect(localDriver.destroy).toHaveBeenCalledTimes(1);
    expect(sandboxClient.destroy).toHaveBeenCalledTimes(1);
  });
});

function driver(): LocalHarnessRuntimeDriver & {
  [K in keyof LocalHarnessRuntimeDriver]: ReturnType<typeof vi.fn>;
} {
  return {
    materialize: vi.fn(async (release) => ({
      bundleHash: contentHash({
        release: release.contentHash,
        projection: "environment",
      }),
    })),
    create: vi.fn(async (manifest) => ({
      id: `lease-${manifest.id}`,
      adapterId: manifest.runtimeTarget.adapterId,
      manifestId: manifest.id,
      acquiredAt: fixtureTimestamp,
      expiresAt: "2026-07-23T13:00:00.000Z",
      metadata: {},
    })),
    reset: vi.fn(async () => undefined),
    step: vi.fn(async () => observation()),
    grade: vi.fn(async () => [graderEvidence()]),
    collect: vi.fn(async () => ({
      traceRefs: ["r2://traces/trace.json"],
      artifactRefs: ["r2://artifacts/receipt.json"],
      contentHash: sha256("runtime-artifacts"),
    })),
    destroy: vi.fn(async () => undefined),
  };
}

function capabilities(
  adapterId: string,
  placements: Array<"local" | "remote">,
) {
  return {
    schemaVersion: "openpond.harnessRuntimeCapabilities.v1" as const,
    adapterId,
    available: true,
    placements,
    lifecycle: [
      "create",
      "reset",
      "step",
      "grade",
      "collect",
      "destroy",
    ] as const,
    deterministicReplay: true,
    privilegedIsolation: true,
    capabilityReceipt: sha256(`${adapterId}-capability`),
    checkedAt: fixtureTimestamp,
    unavailableReason: null,
  };
}

function action(): ModelAction {
  const base = {
    id: "action-1",
    turn: 0,
    kind: "terminal" as const,
    name: null,
    arguments: {},
    content: "42",
  };
  return { ...base, contentHash: contentHash(base) };
}

function observation(): ToolObservation {
  const base = {
    actionId: "action-1",
    turn: 0,
    terminal: true,
    output: { answer: 42 },
    artifactRefs: [],
  };
  return { ...base, contentHash: contentHash(base) };
}

function graderEvidence(): HarnessGraderEvidence {
  const base = {
    graderId: "exact-match",
    graderVersion: "1",
    score: 1,
    passed: true,
    rewardEligible: true,
    failureClass: null,
    feedback: ["matched"],
    visibleEvidenceRefs: [],
    privilegedEvidenceRefs: ["r2://private/reward.json"],
  };
  return { ...base, contentHash: contentHash(base) };
}

function sandboxManifest(harnessHash: string): HarnessRunManifest {
  const source = createManifestFixture();
  const { contentHash: _contentHash, ...content } = source;
  return createHarnessRunManifest({
    ...content,
    harnessRelease: { ...source.harnessRelease, contentHash: harnessHash },
    runtimeTarget: {
      adapterId: "sandbox-latitude",
      placement: "remote",
      capabilityReceipt: sha256("sandbox-latitude-capability"),
      runtimeVersion: "1",
      dataPlane: {
        provider: "latitude",
        dataPlaneId: "latitude-staging",
        cellId: "cell-a",
        runnerPoolId: "pool-a",
        runtimeImageDigest: `sha256:${sha256("sandbox-runtime")}`,
        capabilityReceipt: sha256("latitude-placement"),
      },
    },
  });
}

function localManifest(harnessHash: string): HarnessRunManifest {
  const source = createManifestFixture();
  const { contentHash: _contentHash, ...content } = source;
  return createHarnessRunManifest({
    ...content,
    harnessRelease: { ...source.harnessRelease, contentHash: harnessHash },
    runtimeTarget: {
      adapterId: "local-harness",
      placement: "local",
      capabilityReceipt: sha256("local-harness-capability"),
      runtimeVersion: "1",
      dataPlane: null,
    },
  });
}
