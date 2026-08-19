import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  TasksetReleaseSchema,
  harnessRefinerBenchmarkRelease,
} from "@openpond/evals";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { materializePortableTasksetRelease } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { SqliteStore } from "../apps/server/src/store/store.js";
import { createTrainingApi } from "../apps/server/src/training/training-api.js";
import { createBenchmarkTasksetService } from "../apps/server/src/training/benchmark-tasksets.js";
import { runSandboxedVerifier } from "../apps/server/src/training/sandboxed-verifier.js";
import { withTempDirectory } from "./helpers/temp-directory.js";

describe("shipped benchmark Taskset projection", () => {
  test("ensures the frozen release in a Profile's normal Taskset collection", async () => {
    await withTempDirectory("openpond-benchmark-taskset-", async (storeDir) => {
      const store = new SqliteStore(storeDir);
      try {
        const service = createBenchmarkTasksetService({
          store,
          storeDir,
          now: () => "2026-08-09T12:00:00.000Z",
        });
        const taskset = await service.ensureHarnessRefiner({
          profileId: "benchmark-profile",
        });
        const repeated = await service.ensureHarnessRefiner({
          profileId: "benchmark-profile",
        });

        expect(taskset).toMatchObject({
          profileId: "benchmark-profile",
          purpose: "benchmark",
          status: "ready",
          benchmark: {
            definitionId: "harness-refiner",
            releaseHash: harnessRefinerBenchmarkRelease.contentHash,
            adaptationSplit: "validation",
            evaluationSplit: "frozen_eval",
            primaryMetric: "success_rate",
          },
        });
        expect(taskset.tasks).toHaveLength(20);
        expect(taskset.graders).toHaveLength(1);
        expect(taskset.graders[0]).toMatchObject({
          kind: "custom_verifier",
          hardGate: true,
          rewardEligible: true,
        });
        expect(taskset.metadata.supplementaryModelJudge).toMatchObject({
          calibrationStatus: "pending",
          executable: false,
          rewardEligible: false,
        });
        const verifier = taskset.graders[0];
        const fixtureTask = taskset.tasks.find(
          (task) => task.id === "adaptation-launch-delay-email",
        );
        if (!verifier || verifier.kind !== "custom_verifier" || !fixtureTask) {
          throw new Error("Projected deterministic verifier fixture is unavailable.");
        }
        const allowedRoot = path.join(
          storeDir,
          "training",
          "tasksets",
          taskset.id,
        );
        const positive = await runSandboxedVerifier({
          grader: verifier,
          task: fixtureTask,
          attempt: {
            output: {
              text: "Subject: Acme pilot launch update\n\nThe August 20 launch is moving to August 27 because final accessibility testing is not complete. Testing is expected to finish August 22, and existing pilot access remains available. Please send questions to pilot-support@example.com. Thank you for your patience while we complete this work.",
              requiredOutputs: [],
            },
          } as never,
          allowedRoot,
        });
        const negative = await runSandboxedVerifier({
          grader: verifier,
          task: fixtureTask,
          attempt: {
            output: {
              text: "Draft saved to /workspace/outputs/acme-launch-email.md. Checklist: new date included; accessibility testing mentioned; pilot access preserved; support address included; under 140 words.",
              requiredOutputs: [],
            },
          } as never,
          allowedRoot,
        });
        expect(positive).toMatchObject({ passed: true, score: 1 });
        expect(negative).toMatchObject({ passed: false, score: 0 });
        expect(repeated).toEqual(taskset);
        expect(await store.listTasksets("benchmark-profile")).toEqual([taskset]);

        const release = await service.releaseForTaskset(taskset);
        expect(release).toEqual(TasksetReleaseSchema.parse(
          JSON.parse(await readFile(
            path.join(
              storeDir,
              "training",
              "tasksets",
              taskset.id,
              "benchmark",
              "taskset.release.json",
            ),
            "utf8",
          )),
        ));
        expect(release?.contentHash).toBe(harnessRefinerBenchmarkRelease.contentHash);
        if (!release) throw new Error("Managed benchmark release was not loaded.");
        const portable = materializePortableTasksetRelease({
          taskset,
          adapterId: "openpond.desktop-local-work.v1",
          admittedTasksetRelease: release,
        });
        expect(portable.tasksetRelease).toMatchObject({
          id: release.id,
          graders: release.graders,
          environmentRelease: {
            id: portable.environmentRelease.id,
            contentHash: portable.environmentRelease.contentHash,
          },
          verifierSetRelease: {
            id: portable.verifierSetRelease.id,
            contentHash: portable.verifierSetRelease.contentHash,
          },
        });

        for (const asset of taskset.tasks.flatMap((task) => task.assets)) {
          await expect(access(path.join(
            storeDir,
            "training",
            "tasksets",
            taskset.id,
            asset.artifactRef,
          ))).resolves.toBeUndefined();
        }
      } finally {
        await store.close();
      }
    });
  });

  test("uses a distinct managed Taskset id for each profile", async () => {
    await withTempDirectory("openpond-benchmark-profiles-", async (storeDir) => {
      const store = new SqliteStore(storeDir);
      try {
        const service = createBenchmarkTasksetService({ store, storeDir });
        const first = await service.ensureHarnessRefiner({
          profileId: "first-profile",
        });
        const second = await service.ensureHarnessRefiner({
          profileId: "second-profile",
        });

        expect(first.id).not.toBe(second.id);
        expect(await store.listTasksets("first-profile")).toHaveLength(1);
        expect(await store.listTasksets("second-profile")).toHaveLength(1);
      } finally {
        await store.close();
      }
    });
  });

  test("reprojects a built-in Taskset when the shipped release hash changes", async () => {
    await withTempDirectory("openpond-benchmark-refresh-", async (storeDir) => {
      const store = new SqliteStore(storeDir);
      try {
        const service = createBenchmarkTasksetService({ store, storeDir });
        const current = await service.ensureHarnessRefiner({
          profileId: "refresh-profile",
        });
        const staleSource = {
          ...current,
          revision: current.revision + 1,
          benchmark: {
            ...current.benchmark!,
            releaseHash: "b".repeat(64),
          },
          updatedAt: "2026-08-09T12:30:00.000Z",
        };
        const stale = {
          ...staleSource,
          contentHash: computeTasksetHash(staleSource),
        };
        await store.upsertTaskset(stale);

        const refreshed = await service.ensureHarnessRefiner({
          profileId: "refresh-profile",
        });

        expect(refreshed.revision).toBe(stale.revision + 1);
        expect(refreshed.benchmark?.releaseHash).toBe(
          harnessRefinerBenchmarkRelease.contentHash,
        );
        expect(refreshed.contentHash).not.toBe(stale.contentHash);
      } finally {
        await store.close();
      }
    });
  });

  test("appears automatically when a Profile loads Taskset state", async () => {
    await withTempDirectory("openpond-benchmark-state-", async (storeDir) => {
      const store = new SqliteStore(storeDir);
      try {
        const benchmarkTasksets = createBenchmarkTasksetService({ store, storeDir });
        const api = createTrainingApi({
          store,
          benchmarkTasksets,
          datasetArtifacts: { summaries: async () => [] },
          taskMiner: { config: async () => null },
          training: {
            state: async () => ({
              plans: [],
              bundles: [],
              jobs: [],
              artifacts: [],
              models: [],
              rolloutReceipts: [],
              modelBindings: [],
              destinations: [],
              baseModelCandidates: [],
            }),
          },
        } as never);

        const state = await api.request("state", { profileId: "automatic-profile" }) as {
          tasksets: Array<{ purpose: string; benchmark: { source: string } | null }>;
        };

        expect(state.tasksets).toHaveLength(1);
        expect(state.tasksets[0]).toMatchObject({
          purpose: "benchmark",
          benchmark: { source: "builtin" },
        });
      } finally {
        await store.close();
      }
    });
  });
});
