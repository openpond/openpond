import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  TasksetReleaseSchema,
  harnessRefinerBenchmarkRelease,
} from "@openpond/evals";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { SqliteStore } from "../apps/server/src/store/store.js";
import { createTrainingApi } from "../apps/server/src/training/training-api.js";
import { createBenchmarkTasksetService } from "../apps/server/src/training/benchmark-tasksets.js";
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
          },
        });
        expect(taskset.tasks).toHaveLength(20);
        expect(taskset.graders.find((grader) => grader.kind === "model_judge"))
          .toMatchObject({
            calibrationStatus: "pending",
            rewardEligible: false,
            metadata: { requestedRewardEligible: true },
          });
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
