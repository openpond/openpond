import { OpenPondLearningClient } from "openpond-sdk/learning";
import { createModelLearningHostingService } from "./model-learning-hosting.js";
import { describe, expect, test, vi } from "vitest";
import { OpenPondModelTasksetRunsClient } from "openpond-sdk/model-taskset-runs";

import { createModelProjectHostingService } from "./model-project-hosting.js";
import { createModelTasksetRunHostingService } from "./model-taskset-run-hosting.js";

describe("Model Project hosting", () => {
  // A stale Profile or workspace selection must never send a cancellation to
  // the currently connected account, even when the caller supplies a run ID.
  test("rejects hosted evaluation access outside the selected Profile and connection", async () => {
    const project = { id: "local", profileId: "profile", hosted: { projectId: "hosted", teamId: "team", apiOrigin: "https://host.invalid" } };
    const request = vi.fn(async (_url: string | URL | Request) => Response.json({ items: [], nextCursor: null }));
    const service = createModelTasksetRunHostingService({
      store: { getModelProject: async () => project } as never,
      resolveAccess: async () => ({ apiBaseUrl: "https://host.invalid", teamId: "team", token: "test" }),
      fetch: request,
    });
    await expect(service.cancel({ modelId: "local", profileId: "other", runId: "run" })).rejects.toThrow("this Profile");
    project.hosted.teamId = "other";
    await expect(service.list({ modelId: "local", profileId: "profile" })).rejects.toThrow("active connection");
    project.hosted.teamId = "team";
    project.hosted.apiOrigin = "https://other.invalid";
    await expect(service.cancel({ modelId: "local", profileId: "profile", runId: "run" })).rejects.toThrow("active connection");
    expect(request).not.toHaveBeenCalled();
    project.hosted.apiOrigin = "https://host.invalid";
    expect(await service.list({ modelId: "local", profileId: "profile" })).toEqual({ items: [], nextCursor: null });
    expect(String(request.mock.calls[0]?.[0])).toContain("modelProjectId=hosted");
    // The SDK validates the workspace; this service must additionally reject a
    // valid run belonging to another Model before issuing a destructive call.
    const get = vi.spyOn(OpenPondModelTasksetRunsClient.prototype, "get").mockResolvedValue({ summary: { modelProjectId: "another-model" } } as never);
    const cancel = vi.spyOn(OpenPondModelTasksetRunsClient.prototype, "cancel");
    try {
      await expect(service.cancel({ modelId: "local", profileId: "profile", runId: "foreign-run" })).rejects.toThrow("another Model");
      expect(get).toHaveBeenCalledWith("foreign-run");
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      cancel.mockRestore();
    }
  });
  // A supplied policy or iteration ID must not escape the selected Model,
  // and stale Profile/workspace selections must not contact hosted services.
  test("fences hosted learning commands to their Model and connection", async () => {
    const local = { id: "model", profileId: "profile", hosted: { projectId: "hosted", teamId: "team", apiOrigin: "https://host.invalid" } };
    const project = { id: "hosted", teamId: "team", portableProjectId: "model", name: "Model", objective: null, defaultBaseModel: null,
      defaultDestinationId: null, trainingSetup: emptyTrainingSetup(), sourceRevision: 1, sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      revision: 1, etag: "b".repeat(64), createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
    const request = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("/read")
      ? { items: [], nextCursor: null }
      : { project, resources: [], jobCount: 0, latestJobIds: [] }));
    const service = createModelLearningHostingService({ store: { getModelProject: async () => local } as never,
      resolveAccess: async () => ({ apiBaseUrl: "https://host.invalid", teamId: "team", token: "test" }), fetch: request });
    await expect(service.overview({ modelId: "model", profileId: "other" })).rejects.toThrow("this Profile");
    local.hosted.teamId = "foreign";
    await expect(service.overview({ modelId: "model", profileId: "profile" })).rejects.toThrow("active connection");
    local.hosted.teamId = "team"; local.hosted.apiOrigin = "https://foreign.invalid";
    await expect(service.overview({ modelId: "model", profileId: "profile" })).rejects.toThrow("active connection");
    expect(request).not.toHaveBeenCalled();
    local.hosted.apiOrigin = "https://host.invalid";
    // First-page reads must reach the real SDK transport without undefined JSON fields.
    expect((await service.overview({ modelId: "model", profileId: "profile" })).policies.items).toEqual([]);
    expect((await service.sources({ modelId: "model", profileId: "profile" })).sources.items).toEqual([]);
    const policy = { id: "policy", revision: 1, contentHash: "a".repeat(64), modelProjectId: "foreign", executionOwner: "hosted" };
    const get = vi.spyOn(OpenPondLearningClient.prototype, "get").mockImplementation(async (kind) =>
      (kind === "iteration" ? { policy: { id: "policy", revision: 1, contentHash: policy.contentHash } } : policy) as never);
    const command = vi.spyOn(OpenPondLearningClient.prototype, "command").mockResolvedValue({ resources: [] } as never);
    const cancel = { action: "cancel_iteration" as const, operationId: "cancel", iterationId: "iteration", expectedRevision: 1 };
    try {
      await expect(service.command({ modelId: "model", profileId: "profile", command: cancel })).rejects.toThrow("does not belong");
      expect(command).not.toHaveBeenCalled();
      policy.modelProjectId = "model";
      await service.command({ modelId: "model", profileId: "profile", command: cancel });
      expect(command).toHaveBeenCalledWith(cancel);
      project.portableProjectId = "foreign";
      await expect(service.command({ modelId: "model", profileId: "profile", command: cancel })).rejects.toThrow("identity differs");
      expect(command).toHaveBeenCalledTimes(1);
    } finally { get.mockRestore(); command.mockRestore(); }
  });
  test("discovers hosted projects and pulls a pristine definition without overwriting local work", async () => {
    const hosted = {
      id: "hosted_project_1",
      teamId: "team_1",
      portableProjectId: "model_project_1",
      name: "Hosted taste model",
      objective: "Learn a visual preference policy",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed",
      trainingSetup: emptyTrainingSetup(),
      sourceRevision: 7,
      sourceUpdatedAt: "2026-08-26T12:30:00.000Z",
      revision: 9,
      etag: "b".repeat(64),
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-26T12:30:00.000Z",
    };
    const hostedJob = {
      id: "job_1",
      teamId: "team_1",
      modelProjectId: hosted.id,
      portableProjectId: hosted.portableProjectId,
      sourceProjectRevision: 7,
      publicSubmissionHash: "d".repeat(64),
      approvalHash: "e".repeat(64),
      inputBundleSha256: "f".repeat(64),
      state: "completed",
      targetGroups: 10,
      completedGroups: 10,
      optimizerUpdatesApplied: 8,
      optimizerUpdatesSkipped: 2,
      currentPolicyVersion: 8,
      spendCapUsd: "20.00",
      accruedSpendUsd: "4.25",
      terminalReason: null,
      canonicalPublishState: "published",
      canonicalAdapterArtifactId: "adapter_1",
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T11:00:00.000Z",
      completedAt: "2026-08-26T11:00:00.000Z",
      publicSubmission: {
        job: {
          recipe: { method: "grpo" },
          baseModel: { modelId: "Qwen/Qwen3-8B" },
          resumeFrom: null,
        },
        source: {
          taskset: {
            id: "taskset_1",
            revision: 3,
            contentHash: "a".repeat(64),
          },
        },
      },
    };
    const request = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-openpond-team-id")).toBe("team_1");
      const url = String(urlValue);
      if (url.endsWith("/v1/model-projects")) {
        return Response.json({ projects: [hosted] });
      }
      if (url.endsWith(`/v1/managed-rl/jobs/${hostedJob.id}`)) {
        return Response.json({
          job: {
            job: hostedJob,
            trainingSteps: [{
              id: "step_1",
              jobId: hostedJob.id,
              stepIndex: 1,
              inputPolicyVersion: 0,
              outputPolicyVersion: 1,
              state: "committed",
              metrics: {
                loss: 0.12,
                rewardMean: 0.75,
                rewardMax: 1,
                sampledKl: 0.004,
                gradientNorm: 0.9,
                learningRate: 0.00001,
                trajectoryCount: 4,
              },
              committedAt: hostedJob.completedAt,
              updatedAt: hostedJob.completedAt,
            }],
            evaluations: [{
              id: "evaluation_1",
              jobId: hostedJob.id,
              policyVersion: 1,
              kind: "candidate",
              state: "completed",
              score: "0.80",
              threshold: "0.70",
              passed: true,
              metrics: { passRate: 0.8, taskCount: 10 },
              completedAt: hostedJob.completedAt,
              updatedAt: hostedJob.completedAt,
            }],
            checkpoints: [{
              id: "checkpoint_1",
              jobId: hostedJob.id,
              policyVersion: 1,
              state: "ready",
              createdAt: hostedJob.completedAt,
              updatedAt: hostedJob.completedAt,
            }],
            artifacts: [{
              id: "artifact_1",
              jobId: hostedJob.id,
              state: "ready",
              artifactType: "lora",
              validationMetrics: { candidateMinusBaseline: 0.1 },
              readyAt: hostedJob.completedAt,
              updatedAt: hostedJob.completedAt,
            }],
          },
        });
      }
      if (url.includes("/v1/managed-rl/jobs")) {
        return Response.json({ jobs: [hostedJob] });
      }
      return Response.json({
        project: hosted,
        resources: [{
          kind: "taskset_release",
          ref: { id: "hosted_taskset_1", contentHash: "c".repeat(64) },
          role: "training",
          updatedAt: hosted.updatedAt,
        }],
        jobCount: 2,
        latestJobIds: ["job_1", "job_2"],
      });
    });
    const saveModelProjectHosting = vi.fn(async (_previous: unknown, value: unknown) => value);
    const saveTrainingJob = vi.fn(async (value: unknown) => value);
    const saveTrainingJobEvent = vi.fn(async (value: unknown) => value);
    const service = createModelProjectHostingService({
      store: {
        listModelProjects: vi.fn(async () => []),
        getModelProject: vi.fn(async () => null),
        getTrainingJob: vi.fn(async () => null),
        saveModelProjectHosting,
        saveTrainingJob,
        saveTrainingJobEvent,
        getCacheEntry: vi.fn(async () => null),
        setCacheEntry: vi.fn(async (_type, _key, payload) => ({
          payload,
          updatedAt: hosted.updatedAt,
          error: null,
        })),
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      env: {},
      fetch: request as typeof fetch,
    });

    const catalog = await service.listProjects();
    const pulled = await service.pullProject({
      hostedProjectId: hosted.id,
      profileId: "profile_1",
    });

    expect(catalog.projects).toEqual([
      expect.objectContaining({
        localProjectId: null,
        localRevision: null,
        localState: "not_pulled",
        project: expect.objectContaining({ id: hosted.id }),
      }),
    ]);
    expect(pulled.project).toMatchObject({
      id: hosted.portableProjectId,
      profileId: "profile_1",
      revision: hosted.sourceRevision,
      name: hosted.name,
      hosted: {
        teamId: "team_1",
        projectId: hosted.id,
        etag: hosted.etag,
        syncedSourceRevision: hosted.sourceRevision,
      },
    });
    expect(pulled.hosted).toMatchObject({ jobCount: 2 });
    expect(pulled.importedJobCount).toBe(1);
    expect(pulled.importedMetricCount).toBe(6);
    expect(saveModelProjectHosting).toHaveBeenCalledWith(null, pulled.project, true, []);
    expect(saveTrainingJob).toHaveBeenCalledWith(expect.objectContaining({
      id: hostedJob.id,
      status: "succeeded",
      metadata: expect.objectContaining({
        modelProjectId: hosted.portableProjectId,
        tasksetId: "taskset_1",
        trainingMethod: "grpo",
        hostedTrainingStepCount: 1,
        hostedEvaluationCount: 1,
      }),
    }));
    expect(saveTrainingJobEvent).toHaveBeenCalledWith(expect.objectContaining({
      jobId: hostedJob.id,
      type: "metric",
      payload: expect.objectContaining({
        metricKind: "policy_optimization",
        step: 1,
        meanReward: 0.75,
        policyLoss: 0.12,
        kl: 0.004,
      }),
    }));
    expect(saveTrainingJobEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        metricKind: "managed_telemetry",
        metricId: "evaluation.candidate.score",
        value: 0.8,
      }),
    }));

    // API-created projects can populate the standard pages without downloading
    // their Taskset packages. Refresh must preserve existing local edits.
    Object.assign(hosted.trainingSetup, { tasksetRef: { id: "remote-package", revision: 1, contentHash: "a".repeat(64) } });
    const openScope = { hostedProjectId: hosted.id, profileId: "profile_1", teamId: "team_1", apiOrigin: "https://hosted.example.test" };
    const requestsBeforeOpen = request.mock.calls.length;
    await expect(service.openProject({ ...openScope, teamId: "other" })).rejects.toThrow("active connection");
    expect(request.mock.calls).toHaveLength(requestsBeforeOpen);
    const opened = await service.openProject(openScope);
    expect(opened.importedJobCount).toBe(1);
    expect(opened.importedMetricCount).toBe(6);
    expect(opened.project.trainingSetup.tasksetRef?.id).toBe("remote-package");
    expect(opened.project.hosted?.tasksets).toEqual([]);
    expect(request.mock.calls.slice(requestsBeforeOpen).some(([url]) => String(url).includes("taskset-packages"))).toBe(false);

    const conflictingService = createModelProjectHostingService({
      store: {
        getModelProject: vi.fn(async () => ({
          ...pulled.project,
          revision: pulled.project.revision + 1,
        })),
        saveModelProjectHosting,
        saveTrainingJob: vi.fn(async (value: unknown) => value),
        getTrainingJob: vi.fn(async () => null),
        saveTrainingJobEvent: vi.fn(async (value: unknown) => value),
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      env: {},
      fetch: request as typeof fetch,
    });
    await expect(conflictingService.pullProject({
      hostedProjectId: hosted.id,
      profileId: "profile_1",
    })).rejects.toThrow("Pulling would overwrite local work");
    const savedCount = saveModelProjectHosting.mock.calls.length;
    expect((await conflictingService.openProject(openScope)).project.revision).toBe(pulled.project.revision + 1);
    expect(saveModelProjectHosting.mock.calls).toHaveLength(savedCount);
    await expect(conflictingService.openProject({ ...openScope, profileId: "other" })).rejects.toThrow("different Profile");
  });

  test("serves the persisted hosted catalog without a network wait", async () => {
    const hosted = {
      id: "hosted_project_cached",
      teamId: "team_1",
      portableProjectId: "model_project_cached",
      name: "Cached model",
      objective: null,
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      trainingSetup: emptyTrainingSetup(),
      sourceRevision: 2,
      sourceUpdatedAt: "2026-08-26T12:30:00.000Z",
      revision: 2,
      etag: "a".repeat(64),
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-26T12:30:00.000Z",
    };
    const request = vi.fn(async () => Response.json({ projects: [] }));
    const service = createModelProjectHostingService({
      store: {
        getCacheEntry: vi.fn(async () => ({
          payload: {
            teamId: "team_1",
            projects: [hosted],
            generatedAt: hosted.updatedAt,
          },
          updatedAt: hosted.updatedAt,
          error: null,
        })),
        listModelProjects: vi.fn(async () => []),
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      fetch: request as typeof fetch,
    });

    const catalog = await service.listProjects();

    expect(catalog).toMatchObject({ cached: true, generatedAt: hosted.updatedAt });
    expect(catalog.projects[0]).toMatchObject({
      localState: "not_pulled",
      project: { id: hosted.id },
    });
    expect(request).not.toHaveBeenCalled();
  });

  test("syncs the portable project identity and persists hosted lineage", async () => {
    const project = {
      schemaVersion: "openpond.modelProject.v2" as const,
      id: "model_project_1",
      profileId: "default",
      revision: 4,
      name: "Taste model",
      objective: "Learn a visual preference policy",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      trainingSetup: {
        ...emptyTrainingSetup(),
        managedGpuRequirement: "h100_hbm3" as const,
      },
      hosted: null,
      tasksetSyncs: [],
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:30:00.000Z",
    };
    const saveModelProjectHosting = vi.fn(async (_previous: unknown, value: unknown) => value);
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toBe(
        "application/vnd.openpond.model-project+json;version=2",
      );
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/vnd.openpond.model-project+json;version=2",
      );
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        portableProjectId: project.id,
        sourceRevision: project.revision,
        expectedEtag: null,
      });
      expect(body.trainingSetup).not.toHaveProperty("managedGpuRequirement");
      return new Response(JSON.stringify({
        project: {
          id: "hosted_project_1",
          portableProjectId: project.id,
          revision: 2,
          etag: "b".repeat(64),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const service = createModelProjectHostingService({
      store: {
        getModelProject: vi.fn(async () => project),
        saveModelProjectHosting,
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      env: {},
      fetch: request as typeof fetch,
    });

    const synced = await service.syncProject(project.id);

    expect(synced.hosted).toMatchObject({
      teamId: "team_1",
      projectId: "hosted_project_1",
      portableProjectId: project.id,
      revision: 2,
      syncedSourceRevision: 4,
    });
    expect(synced.trainingSetup.managedGpuRequirement).toBe("h100_hbm3");
    expect(saveModelProjectHosting).toHaveBeenCalledWith(project, synced);
  });

  test("preserves a stale hosted ETag conflict without bypassing the concurrent edit", async () => {
    const project = {
      schemaVersion: "openpond.modelProject.v2" as const,
      id: "model_project_1",
      profileId: "default",
      revision: 4,
      name: "Taste model",
      objective: "Learn a visual preference policy",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      trainingSetup: emptyTrainingSetup(),
      hosted: {
        schemaVersion: "openpond.hostedModelProjectLink.v1" as const,
        apiOrigin: "https://hosted.example.test",
        teamId: "team_1",
        projectId: "hosted_project_1",
        portableProjectId: "model_project_1",
        revision: 1,
        etag: "a".repeat(64),
        syncedSourceRevision: 4,
        syncedAt: "2026-08-25T12:00:00.000Z",
        tasksets: [],
      },
      tasksetSyncs: [],
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:30:00.000Z",
    };
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { expectedEtag: string | null };
      if (body.expectedEtag) {
        return Response.json({ error: "model_project_sync_conflict" }, { status: 409 });
      }
      return Response.json({
        project: {
          id: "hosted_project_1",
          portableProjectId: project.id,
          revision: 2,
          etag: "b".repeat(64),
        },
      });
    });
    const service = createModelProjectHostingService({
      store: {
        getModelProject: vi.fn(async () => project),
        saveModelProjectHosting: vi.fn(async (_previous: unknown, value: unknown) => value),
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      env: {},
      fetch: request as typeof fetch,
    });

    await expect(service.syncProject(project.id)).rejects.toThrow("model_project_sync_conflict");
    expect(request).toHaveBeenCalledTimes(1);
    project.hosted.apiOrigin = "https://another-api.example.test";
    await expect(service.syncProject(project.id)).rejects.toThrow("linked API and workspace");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("preserves hosted validation codes in sync errors", async () => {
    const project = {
      schemaVersion: "openpond.modelProject.v2" as const,
      id: "model_project_invalid",
      profileId: "default",
      revision: 1,
      name: "Invalid project",
      objective: "Expose hosted validation evidence",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      trainingSetup: emptyTrainingSetup(),
      hosted: null,
      tasksetSyncs: [],
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    const service = createModelProjectHostingService({
      store: {
        getModelProject: vi.fn(async () => project),
        saveModelProjectHosting: vi.fn(async (_previous: unknown, value: unknown) => value),
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      env: {},
      fetch: vi.fn(async () => Response.json({
        schemaVersion: "openpond.modelProjectApiError.v2",
        code: "managed_gpu_placement_objective_invalid",
        message: "Model Project sync failed.",
        retryable: false,
        requestId: null,
        details: {},
      }, { status: 400 })) as typeof fetch,
    });

    await expect(service.syncProject(project.id)).rejects.toThrow(
      "Model Project sync failed. (managed_gpu_placement_objective_invalid)",
    );
  });

  // Complete-package publication, attachment and restart recovery are covered
  // with a real SQLite store in model-starter-taskset.test.ts.

});

function emptyTrainingSetup() {
  return {
    tasksetRef: null,
    tasksetRelease: null,
    harnessRelease: null,
    baseModel: null,
    method: null,
    destinationId: null,
    managedRolloutPlacement: "remote" as const,
    runPreset: null,
    recipe: null,
    preferredMaximumSpendUsd: null,
    preferredRetentionDays: null,
  };
}
