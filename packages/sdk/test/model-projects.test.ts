import { describe, expect, it, vi } from "vitest";

import {
  HostedModelProjectSyncSchema,
  ModelProjectSchema,
  createModelProjectsClient,
  createModelProjectSaveRequest,
  parseModelProjectSaveRequest,
  HostedModelProjectSummarySchema,
} from "../src/model-projects.js";
import { createHostedLearningPolicyContent, hostedLearningPolicyDefaults, hostedLearningPolicyReferences } from "../src/model-learning-policy.js";
import { sealLearningContent } from "@openpond/evals/learning";

const HASH = "a".repeat(64);
const NOW = "2026-08-26T20:00:00.000Z";

// Editing cadence must not silently follow newer Model weights, reset reviewed
// limits or enable automatic acceptance. Both clients compile this same draft.
it("preserves reviewed learning configuration until explicitly applied and rejects invalid admission", () => {
  const ref = { id: "source", revision: 1, contentHash: HASH };
  const project = HostedModelProjectSummarySchema.parse({ ...hostedProject(),
    defaultBaseModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: "base-model", revision: "weights-one",
      tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" },
    trainingSetup: { ...hostedProject().trainingSetup, rewardBindingRef: ref,
      evaluationTasksetRef: { id: "retained-taskset", revision: 1, contentHash: HASH } },
  });
  const initial = { project, previous: null, policyId: "policy", applyModelConfiguration: true,
    sources: [ref], taskDefinition: ref, settings: hostedLearningPolicyDefaults(project, null) };
  const previous = sealLearningContent(createHostedLearningPolicyContent(initial));
  expect(previous.enabled).toBe(false);
  expect(previous.admission.mode).toBe("human");
  for (const method of ["sft", "ppo"] as const) {
    const unsupported = { ...initial, project: { ...project, trainingSetup: { ...project.trainingSetup,
      recipe: { ...project.trainingSetup.recipe!, method } } } };
    expect(createHostedLearningPolicyContent(unsupported).enabled).toBe(false);
    expect(() => createHostedLearningPolicyContent({ ...unsupported,
      settings: { ...unsupported.settings, enabled: true } })).toThrow("Hosted continual learning currently supports GRPO");
  }
  const changed = { ...project, etag: "b".repeat(64), trainingSetup: { ...project.trainingSetup,
    baseModel: { ...project.defaultBaseModel!, revision: "weights-two" },
    evaluationTasksetRef: { id: "new-retained", revision: 2, contentHash: "b".repeat(64) } } };
  const draft = { ...initial, project: changed, previous, applyModelConfiguration: false,
    settings: { ...hostedLearningPolicyDefaults(changed, previous), scheduled: true } };
  const preserved = createHostedLearningPolicyContent(draft);
  expect(preserved.trainingParent).toEqual(previous.trainingParent);
  expect(preserved.training).toEqual(previous.training);
  expect(preserved.limits).toEqual(previous.limits);
  expect(preserved.automation).toEqual({ collect: false, train: true, accept: false, serve: false });
  const applied = createHostedLearningPolicyContent({ ...draft, applyModelConfiguration: true });
  expect(applied.trainingParent).not.toEqual(previous.trainingParent);
  expect(applied.training.retentionEvaluation.id).toBe("new-retained");
  expect(() => createHostedLearningPolicyContent({ ...draft, project: { ...changed, portableProjectId: "another-model" } })).toThrow("learning_policy_model_mismatch");
  expect(() => createHostedLearningPolicyContent({ ...draft, settings: { ...draft.settings, humanReviewRequired: false } })).toThrow("qualification evidence");
  expect(() => createHostedLearningPolicyContent({ ...draft, settings: { ...draft.settings, maxDailySpendUsd: 0.01 } })).toThrow("Daily spend");
});

// UI and execution-owner snapshots must pin the same reviewed configuration;
// changing a Model's base revision or Harness selection cannot reuse its plan.
it("preserves hosted policy reference identity across configuration review", () => {
  const project = HostedModelProjectSummarySchema.parse({ ...hostedProject(),
    defaultBaseModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: "base-model", revision: "weights-one",
      tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" },
    trainingSetup: { ...hostedProject().trainingSetup, evaluationTasksetRef: { id: "retained-taskset", revision: 1, contentHash: HASH } },
  });
  const refs = hostedLearningPolicyReferences(project);
  expect(refs.recipe.id).toBe(`model-recipe-${HASH}`);
  expect(refs.retentionEvaluation).toEqual({ id: "retained-taskset", contentHash: HASH });
  const changedHarness = { ...project, etag: "b".repeat(64), trainingSetup: { ...project.trainingSetup, harnessRelease: { id: "new-harness", contentHash: "b".repeat(64) } } };
  expect(hostedLearningPolicyReferences(changedHarness).recipe).toEqual({ id: `model-recipe-${"b".repeat(64)}`, contentHash: refs.recipe.contentHash });
  expect(hostedLearningPolicyReferences({ ...project, trainingSetup: { ...project.trainingSetup, baseModel: { ...project.defaultBaseModel!, revision: "weights-two" } } }).trainingParent)
    .not.toEqual(refs.trainingParent);
  expect(() => hostedLearningPolicyReferences({ ...project, trainingSetup: { ...project.trainingSetup, evaluationTasksetRef: null } })).toThrow("learning_model_configuration_incomplete");
});

// Durable retries identify authored content, while hostile recursive recipes and
// attempts to replace server-owned hosting receipts never enter the save path.
it("builds stable Model save requests and bounds untrusted recipe JSON", async () => {
  const editable = { id: "model-one", profileId: "default", name: "One", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: setup() };
  const request = await createModelProjectSaveRequest(editable, 0);
  expect(await createModelProjectSaveRequest({ ...editable }, 0)).toEqual(request);
  expect((await createModelProjectSaveRequest({ ...editable, name: "Two" }, 0)).operationId).not.toBe(request.operationId);
  const learning = { mode: "nightly" as const, minimumTasks: 10, localTime: "20:00", timeZone: "America/New_York", maximumSpendUsd: 1, maximumDailySpendUsd: 1 };
  const scheduled = await createModelProjectSaveRequest(editable, 0, learning);
  expect(scheduled.operationId).not.toBe(request.operationId);
  expect((await createModelProjectSaveRequest(editable, 0, { ...learning, localTime: "21:00" })).operationId).not.toBe(scheduled.operationId);
  await expect(createModelProjectSaveRequest(editable, 1, learning)).rejects.toThrow("existing Model");
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
  // Configuration uses a distinct JSON transport and must preserve retry
  // identity and domain conflicts when moved between Desktop and hosted UI.
  it("sends exact configuration requests and exposes authoritative conflicts", async () => {
    const request = await createModelProjectSaveRequest({ id: "project-1", profileId: "team-1", name: "Support model", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: { rewardBindingRef: { id: "reward-first", revision: 2, contentHash: HASH } } }, 3);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ accept: "application/json", "content-type": "application/json", authorization: "Bearer test" });
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return Response.json(hostedProject());
    });
    const client = createModelProjectsClient({ baseUrl: "https://api.openpond.test", fetch, headers: { authorization: "Bearer test" } });
    expect((await client.saveConfiguration(request)).id).toBe("hosted-project-1");
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openpond.test/v1/model-projects/configuration/save");
    fetch.mockImplementationOnce(async () => Response.json({ schemaVersion: "openpond.modelProjectApiError.v2", code: "model_revision_conflict", message: "Model changed.", retryable: false, requestId: null, details: {} }, { status: 409 }));
    await expect(client.saveConfiguration(request)).rejects.toMatchObject({ status: 409, code: "model_revision_conflict" });
  });

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
