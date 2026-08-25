import { describe, expect, test, vi } from "vitest";

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
});
