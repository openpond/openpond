import { describe, expect, test, vi } from "vitest";

import { createTrainingApi } from "../apps/server/src/training/training-api";

describe("training API Model Run approval forwarding", () => {
  test("forwards Reward Model cancellation to its separate lifecycle", async () => {
    const cancelRewardModelRun = vi.fn(async (runId: string) => ({ runId }));
    const api = createTrainingApi({ training: { cancelRewardModelRun } } as never);

    await api.request("reward_model_run_cancel", { runId: "reward-run-rm0" });

    expect(cancelRewardModelRun).toHaveBeenCalledWith("reward-run-rm0");
  });

  test("forwards explicit export approval to Model Run start", async () => {
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      store: {
        getModelProject: vi.fn(async () => ({ trainingSetup: { destinationId: "local" } })),
      },
      training: { startModelRun },
    } as never);

    await api.request("start_model_run", {
      modelProjectId: "model_approved",
      maximumSpendUsd: 2,
      retentionDays: 1,
      exportApproved: true,
    });

    expect(startModelRun).toHaveBeenCalledWith({
      modelProjectId: "model_approved",
      maximumSpendUsd: 2,
      retentionDays: 1,
      exportApproved: true,
      manifest: undefined,
      comparisonSeriesEntryId: null,
    });
  });

  test("does not infer export approval when the caller omits it", async () => {
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      store: {
        getModelProject: vi.fn(async () => ({ trainingSetup: { destinationId: "local" } })),
      },
      training: { startModelRun },
    } as never);

    await api.request("start_model_run", {
      modelProjectId: "model_unapproved",
      maximumSpendUsd: 2,
      retentionDays: 1,
    });

    expect(startModelRun).toHaveBeenCalledWith(
      expect.objectContaining({ exportApproved: false }),
    );
  });

  test("publishes the exact Taskset release before a managed Model Run starts", async () => {
    const release = {
      schemaVersion: "openpond.tasksetRelease.v1",
      id: "taskset-release-1",
      revision: 3,
      contentHash: "a".repeat(64),
    };
    const taskset = { id: "taskset_1" };
    const publishTaskset = vi.fn(async () => ({ id: "model_1" }));
    const startModelRun = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      benchmarkTasksets: {
        releaseForTaskset: vi.fn(async () => release),
      },
      modelProjectHosting: { publishTaskset },
      store: {
        getModelProject: vi.fn(async () => ({
          id: "model_1",
          trainingSetup: {
            destinationId: "openpond_managed",
            tasksetRef: { id: "taskset_1", revision: 3, contentHash: "b".repeat(64) },
          },
        })),
        getTasksetRevision: vi.fn(async (id, revision, hash) => {
          expect([id, revision, hash]).toEqual(["taskset_1", 3, "b".repeat(64)]);
          return taskset;
        }),
      },
      training: { startModelRun },
    } as never);

    await api.request("start_model_run", { modelProjectId: "model_1" });

    expect(publishTaskset).toHaveBeenCalledWith({
      projectId: "model_1",
      taskset,
      release,
    });
    expect(startModelRun).toHaveBeenCalledOnce();
  });

  test("forwards the exact Taskset and qualified Reward Model Version for a policy binding", async () => {
    const learnedPreferenceRewardBinding = vi.fn(async (input: unknown) => ({
      ...input as Record<string, unknown>,
      rewardComposerRelease: { id: "reward-composer-r0", contentHash: "a".repeat(64) },
    }));
    const api = createTrainingApi({
      training: { learnedPreferenceRewardBinding },
    } as never);

    await expect(api.request("learned_preference_reward_binding", {
      tasksetId: "taskset-t0",
      rewardModelVersionId: "reward-r0",
    })).resolves.toMatchObject({
      tasksetId: "taskset-t0",
      rewardModelVersionId: "reward-r0",
    });
    expect(learnedPreferenceRewardBinding).toHaveBeenCalledWith({
      tasksetId: "taskset-t0",
      rewardModelVersionId: "reward-r0",
    });
  });

  test("pins the preference dataset's released Taskset envelope in Reward Model recipes", async () => {
    const tasksetRelease = {
      id: "taskset-release-t0-r1",
      revision: 1,
      contentHash: "b".repeat(64),
    };
    const comparisonRelease = {
      id: "comparison-r1",
      contentHash: "d".repeat(64),
    };
    const launchRewardModel = vi.fn(async (input: unknown) => input);
    const api = createTrainingApi({
      store: {
        getTaskset: vi.fn(async () => ({
          id: "taskset-t0",
          contentHash: "a".repeat(64),
        })),
        getPreferenceComparisonRelease: vi.fn(async () => ({
          tasksetId: "taskset-t0",
          tasksetRelease,
          release: comparisonRelease,
        })),
        getModelProject: vi.fn(async () => ({
          id: "model-project-t0",
          trainingSetup: { tasksetRef: { id: "taskset-t0" } },
        })),
      },
      preferenceComparisons: {
        listPreferenceDatasets: vi.fn(async () => [{
          id: "preferences-d0",
          contentHash: "c".repeat(64),
          tasksetRelease,
          comparisonRelease,
        }]),
      },
      training: { launchRewardModel },
    } as never);

    await api.request("reward_model_run_launch", {
      id: "reward-run-rm0",
      tasksetId: "taskset-t0",
      modelProjectId: "model-project-t0",
      rewardModelId: "reward-model-r0",
      preferenceDatasetReleaseId: "preferences-d0",
    });

    expect(launchRewardModel).toHaveBeenCalledWith(expect.objectContaining({
      tasksetRelease,
      recipe: expect.objectContaining({
        tasksetRelease: {
          id: tasksetRelease.id,
          contentHash: tasksetRelease.contentHash,
        },
      }),
    }));
  });

  test("routes evaluation cancellation to the Harness Refiner execution", async () => {
    const cancelEvaluation = vi.fn(async (id: string) => ({ id, status: "cancelled" }));
    const cancelTraining = vi.fn();
    const api = createTrainingApi({
      store: {
        getModelRun: vi.fn(async () => ({ kind: "evaluation" })),
      },
      training: { cancelModelRun: cancelTraining },
      harnessRefinerBenchmarks: { cancel: cancelEvaluation },
    } as never);

    await api.request("cancel_model_run", { modelRunId: "model_run_eval" });

    expect(cancelEvaluation).toHaveBeenCalledWith("model_run_eval");
    expect(cancelTraining).not.toHaveBeenCalled();
  });

  test("keeps non-evaluation cancellation on the training execution", async () => {
    const cancelEvaluation = vi.fn();
    const cancelTraining = vi.fn(async (id: string) => ({ id, status: "cancelled" }));
    const api = createTrainingApi({
      store: {
        getModelRun: vi.fn(async () => ({ kind: "training" })),
      },
      training: { cancelModelRun: cancelTraining },
      harnessRefinerBenchmarks: { cancel: cancelEvaluation },
    } as never);

    await api.request("cancel_model_run", { modelRunId: "model_run_training" });

    expect(cancelTraining).toHaveBeenCalledWith("model_run_training");
    expect(cancelEvaluation).not.toHaveBeenCalled();
  });

  test("routes evaluation resume to the durable Harness Refiner checkpoint", async () => {
    const resume = vi.fn(async (id: string) => ({ id, status: "running" }));
    const api = createTrainingApi({
      store: {
        getModelRun: vi.fn(async () => ({ kind: "evaluation" })),
      },
      harnessRefinerBenchmarks: { resume },
    } as never);

    await api.request("resume_model_run", { modelRunId: "model_run_eval" });

    expect(resume).toHaveBeenCalledWith("model_run_eval");
  });
});

// Polling must agree with the full snapshot across profiles, and navigation must
// never pull task bodies or training traces into every chat window.
test("training overview reads compact metadata with the same revision scope as full state", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteStore } = await import("../apps/server/src/store/store");
  const { projectTrainingActivity } = await import("../apps/server/src/training/training-activity");
  const directory = await mkdtemp(join(tmpdir(), "openpond-training-overview-"));
  const store = new SqliteStore(directory);
  let database: InstanceType<typeof DatabaseSync> | undefined;
  const timestamp = "2026-10-12T00:00:00.000Z";
  try {
    await store.sessionShells();
    database = new DatabaseSync(store.storePath);
    const taskset = { id: "taskset", revision: 1, contentHash: "a".repeat(64), updatedAt: timestamp };
    const model = { id: "model-other-profile", name: "Other profile model", revision: 1, updatedAt: timestamp };
    database.prepare("INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(taskset.id, "selected", "ready", JSON.stringify({ ...taskset, tasks: [{ body: "x".repeat(2_000_000) }] }), timestamp, timestamp);
    database.prepare("INSERT INTO model_projects (id, profile_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(model.id, "other", JSON.stringify(model), timestamp, timestamp);
    database.prepare("INSERT INTO training_sources (id, profile_id, source_kind, session_id, source_hash, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("source", "selected", "chat", "chat-source", "a".repeat(64), JSON.stringify({ sessionId: "chat-source" }), timestamp, timestamp);
    const creation = { id: "creation", state: "ready", updatedAt: timestamp };
    database.prepare("INSERT INTO task_creation_snapshots (id, profile_id, state, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(creation.id, "selected", creation.state, JSON.stringify({ ...creation, request: { sourceIds: ["source"] } }), timestamp, timestamp);
    const metadata = await store.readTrainingActivityState("selected");
    const snapshot = { jobs: [], creations: [creation], minerRuns: [], datasetImports: [], tasksetDrafts: [], tasksets: [taskset], modelProjects: [model] };
    const expected = projectTrainingActivity({ profileId: "selected", state: snapshot as never });
    expect(projectTrainingActivity({ profileId: "selected", state: { ...metadata, jobs: [] } }).revision).toBe(expected.revision);
    expect(JSON.stringify(metadata).length).toBeLessThan(2000);
    expect(await store.readTrainingNavigation("selected")).toEqual({
      projects: [{ id: model.id, name: model.name, teamId: null }],
      activityByProjectId: {}, creationSessionIds: ["chat-source"],
    });
    expect((await store.readTrainingNavigation("other")).creationSessionIds).toEqual([]);
    database.prepare("UPDATE model_projects SET payload = json_set(payload, '$.revision', 2) WHERE id = ?").run(model.id);
    expect(projectTrainingActivity({ profileId: "selected", state: { ...await store.readTrainingActivityState("selected"), jobs: [] } }).revision).not.toBe(expected.revision);
  } finally {
    database?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
