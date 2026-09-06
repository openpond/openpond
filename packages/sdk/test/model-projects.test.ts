import { describe, expect, it, vi } from "vitest";

import {
  HostedModelProjectSyncSchema,
  ModelProjectSchema,
  createModelProjectsClient,
  createModelProjectSaveRequest,
  parseModelProjectSaveRequest,
} from "../src/model-projects.js";

const HASH = "a".repeat(64);
const NOW = "2026-08-26T20:00:00.000Z";

// Durable retries identify authored content, while hostile recursive recipes and
// attempts to replace server-owned hosting receipts never enter the save path.
it("builds stable Model save requests and bounds untrusted recipe JSON", async () => {
  const editable = { id: "model-one", profileId: "default", name: "One", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: setup() };
  const request = await createModelProjectSaveRequest(editable, 0);
  expect(await createModelProjectSaveRequest({ ...editable }, 0)).toEqual(request);
  expect((await createModelProjectSaveRequest({ ...editable, name: "Two" }, 0)).operationId).not.toBe(request.operationId);
  expect(() => parseModelProjectSaveRequest({ ...request, project: { ...request.project, hosted: null } })).toThrow();
  let nested: unknown = {};
  for (let index = 0; index < 60; index++) nested = { child: nested };
  expect(() => parseModelProjectSaveRequest({ ...request, project: { ...request.project, trainingSetup: { ...request.project.trainingSetup, recipe: nested } } })).toThrow(expect.objectContaining({ status: 400, code: "model_configuration_json_invalid" }));
});

function setup() {
  return {
    tasksetRef: { id: "taskset-1", revision: 2, contentHash: HASH },
    tasksetRelease: { id: "taskset-release-1", contentHash: HASH },
    harnessRelease: { id: "harness-release-1", contentHash: HASH },
    baseModel: null,
    method: "grpo" as const,
    destinationId: "openpond_managed",
    managedRolloutPlacement: "remote" as const,
    managedGpuPlacementObjective: "balanced" as const,
    managedGpuRequirement: "any" as const,
    runPreset: "standard" as const,
    recipe: {
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo" as const,
      parameterization: "lora" as const,
      rollout: { groupSize: 4 },
    },
    preferredMaximumSpendUsd: 10,
    preferredRetentionDays: 7,
  };
}

function hostedProject() {
  const { managedGpuRequirement: _managedGpuRequirement, ...trainingSetup } = setup();
  return {
    id: "hosted-project-1",
    teamId: "team-1",
    portableProjectId: "project-1",
    name: "Support model",
    objective: "Improve support resolution quality.",
    defaultBaseModel: null,
    defaultDestinationId: "openpond_managed",
    trainingSetup,
    sourceRevision: 3,
    sourceUpdatedAt: NOW,
    revision: 4,
    etag: HASH,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Model Project SDK contracts", () => {
  it("stores one bounded current setup on the Project", () => {
    const project = ModelProjectSchema.parse({
      schemaVersion: "openpond.modelProject.v2",
      id: "project-1",
      profileId: "personal",
      revision: 3,
      name: "Support model",
      objective: "Improve support resolution quality.",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed",
      trainingSetup: setup(),
      hosted: null,
      tasksetSyncs: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(project.trainingSetup.method).toBe("grpo");
    expect(project).not.toHaveProperty("modelRunDrafts");
    expect(project.trainingSetup).not.toHaveProperty("approvalHash");
    expect(project.trainingSetup).not.toHaveProperty("jobEvents");
  });

  it("rejects runtime state and explicit approval authority on Project sync", () => {
    expect(() =>
      HostedModelProjectSyncSchema.parse({
        schemaVersion: "openpond.hostedModelProjectSync.v2",
        portableProjectId: "project-1",
        name: "Support model",
        objective: null,
        defaultBaseModel: null,
        defaultDestinationId: null,
        trainingSetup: {
          ...setup(),
          approvalHash: HASH,
        },
        sourceRevision: 1,
        sourceUpdatedAt: NOW,
        expectedEtag: null,
      }),
    ).toThrow();
  });

  it("uses the versioned Project endpoint and validates the response", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ project: hostedProject() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createModelProjectsClient({
      baseUrl: "https://api.openpond.test/",
      fetch,
      headers: { authorization: "Bearer test" },
    });
    const { managedGpuRequirement: _managedGpuRequirement, ...trainingSetup } = setup();
    const project = await client.upsert({
      schemaVersion: "openpond.hostedModelProjectSync.v2",
      portableProjectId: "project-1",
      name: "Support model",
      objective: "Improve support resolution quality.",
      defaultBaseModel: null,
      defaultDestinationId: "openpond_managed",
      trainingSetup,
      sourceRevision: 3,
      sourceUpdatedAt: NOW,
      expectedEtag: null,
    });

    expect(project.id).toBe("hosted-project-1");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openpond.test/v1/model-projects/project-1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("keeps the Project detail envelope intact", async () => {
    const detail = {
      project: hostedProject(),
      resources: [],
      jobCount: 2,
      latestJobIds: ["job-2", "job-1"],
    };
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify(detail), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createModelProjectsClient({
      baseUrl: "https://api.openpond.test",
      fetch,
    });

    await expect(client.get("project-1")).resolves.toEqual(detail);
  });
});
