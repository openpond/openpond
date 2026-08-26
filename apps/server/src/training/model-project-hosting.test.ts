import { describe, expect, test, vi } from "vitest";
import { gunzipSync } from "node:zlib";

import { createModelProjectHostingService } from "./model-project-hosting.js";

describe("Model Project hosting", () => {
  test("syncs the portable project identity and persists hosted lineage", async () => {
    const project = {
      schemaVersion: "openpond.modelProject.v1" as const,
      id: "model_project_1",
      profileId: "default",
      revision: 4,
      name: "Taste model",
      objective: "Learn a visual preference policy",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      hosted: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:30:00.000Z",
    };
    const saveModelProject = vi.fn(async (value: unknown) => value);
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        portableProjectId: project.id,
        sourceRevision: project.revision,
        expectedEtag: null,
      });
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
        saveModelProject,
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
    expect(saveModelProject).toHaveBeenCalledWith(synced);
  });

  test("retries a stale hosted container ETag with the local source revision", async () => {
    const project = {
      schemaVersion: "openpond.modelProject.v1" as const,
      id: "model_project_1",
      profileId: "default",
      revision: 4,
      name: "Taste model",
      objective: "Learn a visual preference policy",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      hosted: {
        schemaVersion: "openpond.hostedModelProjectLink.v1" as const,
        teamId: "team_1",
        projectId: "hosted_project_1",
        portableProjectId: "model_project_1",
        revision: 1,
        etag: "a".repeat(64),
        syncedSourceRevision: 4,
        syncedAt: "2026-08-25T12:00:00.000Z",
        tasksets: [],
      },
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
        saveModelProject: vi.fn(async (value: unknown) => value),
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

    expect(request).toHaveBeenCalledTimes(2);
    expect(synced.hosted?.etag).toBe("b".repeat(64));
  });

  test("publishes immutable Taskset releases with compressed transport", async () => {
    const project = {
      schemaVersion: "openpond.modelProject.v1" as const,
      id: "model_project_1",
      profileId: "default",
      revision: 1,
      name: "Taste model",
      objective: "Learn taste",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed" as const,
      hosted: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    let saved = project as unknown;
    const request = vi.fn(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const url = String(urlValue);
      if (url.endsWith(`/v1/model-projects/${project.id}`)) {
        return Response.json({
          project: {
            id: "hosted_project_1",
            portableProjectId: project.id,
            revision: 1,
            etag: "b".repeat(64),
          },
        });
      }
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/vnd.openpond.taskset-publication+json+gzip",
      );
      const publication = JSON.parse(
        gunzipSync(Buffer.from(init?.body as Uint8Array)).toString("utf8"),
      );
      expect(publication).toMatchObject({
        modelProjectId: "hosted_project_1",
        release: { id: "taskset_1", revision: 1 },
      });
      return Response.json({
        project: {
          id: "hosted_project_1",
          portableProjectId: project.id,
          revision: 1,
          etag: "b".repeat(64),
        },
        taskset: {
          id: "hosted_taskset_1",
          portableTasksetId: "taskset_1",
          revision: 1,
          contentHash: "a".repeat(64),
        },
      });
    });
    const service = createModelProjectHostingService({
      store: {
        getModelProject: vi.fn(async () => saved),
        saveModelProject: vi.fn(async (value: unknown) => {
          saved = value;
          return value;
        }),
      } as never,
      resolveAccess: async () => ({
        apiBaseUrl: "https://hosted.example.test",
        teamId: "team_1",
        token: "test-token",
      }),
      env: {},
      fetch: request as typeof fetch,
    });
    await service.publishTaskset({
      projectId: project.id,
      taskset: {
        id: "taskset_1",
        name: "Taskset",
        objective: "Rank outputs",
        preferenceComparison: null,
        graders: [],
      } as never,
      release: {
        schemaVersion: "openpond.tasksetRelease.v2",
        id: "taskset_1",
        revision: 1,
        policy: {
          policyVisibleFields: [],
          privilegedFields: [],
          hiddenGraderRefs: [],
          connectedAppScopes: [],
        },
        environment: {
          protocolVersion: "openpond.environment.v1",
          kind: "text",
          entrypoint: "chat",
          stateful: false,
          deterministicSeeds: true,
          lifecycle: ["create", "reset", "step", "collect", "destroy"],
          networkPolicy: "none",
          defaultTimeoutMs: 30_000,
        },
        tools: [],
        capabilities: [],
        tasks: [{
          id: "task_1",
          clusterKey: "cluster_1",
          split: "train",
          input: { prompt: "Choose traits" },
          expectedOutput: null,
          policyVisibleContext: {},
          privilegedContextRef: null,
          artifactRefs: [],
          tags: [],
        }],
        graders: [{
          id: "schema_grader",
          version: "1",
          weight: 1,
          hardGate: true,
          rewardEligible: true,
          privileged: false,
          kind: "schema",
          config: {},
        }],
        metadata: {},
        contentHash: "a".repeat(64),
      } as never,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
