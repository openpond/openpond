import { describe, expect, test } from "vitest";
import type {
  ModelArtifactLineage,
  ModelBinding,
  Taskset,
  TrainingJob,
  TrainingStateResponse,
} from "@openpond/contracts";

import {
  currentModelBinding,
  labModelDatasets,
  labModelJobs,
  labModelPlans,
  labModelVersions,
} from "../apps/web/src/components/labs/lab-models";
import {
  labWorkproductProjection,
  type LabWorkproductSummary,
} from "../apps/web/src/components/labs/lab-workproducts";
import {
  createExistingTasksetModelCreateImproveRun,
} from "../apps/server/src/training/model-create-improve";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import { planFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Lab Model workspace projection", () => {
  test("keeps multiple Dataset runs and methods under one stable Model with a current Version", () => {
    const modelId = "model_fixture_stable";
    const firstDataset = tasksetFixture({ ready: true });
    const secondDataset = {
      ...tasksetFixture({ ready: true }),
      id: "taskset_fixture_second",
      name: "Fixture Taskset Second",
      revision: 2,
      updatedAt: "2026-07-13T00:00:00.000Z",
    } as Taskset;
    const firstPlan = {
      ...planFixture(firstDataset),
      id: "training_plan_first",
      modelId,
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    const secondPlan = {
      ...planFixture(secondDataset),
      id: "training_plan_second",
      modelId,
      recipe: {
        ...planFixture(secondDataset).recipe,
        method: "grpo",
        schemaVersion: "openpond.rftRecipe.v1",
      },
      createdAt: "2026-07-13T00:00:00.000Z",
    } as typeof firstPlan;
    const jobs = [
      job("training_job_first", firstPlan.id, "2026-07-12T01:00:00.000Z"),
      job("training_job_second", secondPlan.id, "2026-07-13T01:00:00.000Z"),
    ];
    const versions = [
      lineage(
        "lineage_first",
        modelId,
        firstDataset.id,
        jobs[0]!.id,
        "2026-07-12T02:00:00.000Z",
      ),
      lineage(
        "lineage_second",
        modelId,
        secondDataset.id,
        jobs[1]!.id,
        "2026-07-13T02:00:00.000Z",
      ),
    ];
    const binding = {
      schemaVersion: "openpond.modelBinding.v1",
      id: "model_binding_current",
      profileId: "default",
      role: "chat_manual",
      roleTargetId: modelId,
      modelArtifactLineageId: versions[1]!.id,
      tasksetId: secondDataset.id,
      evaluationArtifactId: "evaluation_second",
      status: "active",
      priorBindingId: null,
      rollbackTargetBindingId: null,
      promotedBy: "0xglu",
      promotedAt: "2026-07-13T03:00:00.000Z",
      rolledBackAt: null,
      metadata: {},
    } satisfies ModelBinding;
    const state = {
      tasksets: [firstDataset, secondDataset],
      plans: [firstPlan, secondPlan],
      jobs,
      models: versions,
      modelBindings: [binding],
    } as unknown as TrainingStateResponse;
    const run = createImproveRunFixture({
      id: "create_improve_model_fixture",
      state: "ready",
      target: {
        kind: "model",
        id: modelId,
        displayName: "Fixture Model",
        trainingPlanId: secondPlan.id,
        trainingJobId: jobs[1]!.id,
        artifactId: versions[1]!.artifactId,
      },
    });
    const workproduct: LabWorkproductSummary = {
      key: `model:${modelId}`,
      kind: "model",
      id: modelId,
      name: "Fixture Model",
      description: "One shippable Model with multiple training attempts.",
      status: "Ready",
      updatedAt: versions[1]!.importedAt,
      path: null,
      enabled: true,
      runIds: [run.id],
      conversationId: null,
      tasksetId: secondDataset.id,
      trainingRunCount: 2,
      evaluationStatus: "passed",
      frontierBaselineRunId: null,
      useActionId: null,
    };

    expect(labModelPlans(workproduct, [run], state)).toHaveLength(2);
    expect(labModelJobs(workproduct, [run], state).map((item) => item.id)).toEqual([
      "training_job_second",
      "training_job_first",
    ]);
    expect(
      labModelDatasets(workproduct, [run], state).map((item) => item.id),
    ).toEqual(["taskset_fixture", "taskset_fixture_second"]);
    expect(
      labModelVersions(workproduct, [run], state).map((version) => ({
        id: version.lineage.id,
        number: version.number,
        current: version.current,
      })),
    ).toEqual([
      { id: "lineage_second", number: 2, current: true },
      { id: "lineage_first", number: 1, current: false },
    ]);
    expect(currentModelBinding(workproduct, [run], state)?.id).toBe(
      binding.id,
    );
  });

  test("coalesces executed pre-identity runs without merging new reusable-Dataset drafts", () => {
    const taskset = tasksetFixture({ ready: true });
    const firstPlan = {
      ...planFixture(taskset),
      id: "training_plan_legacy_first",
      modelId: null,
    };
    const secondPlan = {
      ...planFixture(taskset),
      id: "training_plan_legacy_second",
      modelId: null,
      createdAt: "2026-07-13T00:00:00.000Z",
    };
    const first = createExistingTasksetModelCreateImproveRun({
      profileId: "default",
      taskset,
      modelId: "model_legacy_first",
      preferredBaseModelId: "accounts/fireworks/models/qwen3-8b",
      preferredBaseModel: managedPreference(),
      timestamp: "2026-07-12T00:00:00.000Z",
    });
    const second = createExistingTasksetModelCreateImproveRun({
      profileId: "default",
      taskset,
      modelId: "model_legacy_second",
      preferredBaseModelId: "accounts/fireworks/models/qwen3-8b",
      preferredBaseModel: managedPreference(),
      timestamp: "2026-07-13T00:00:00.000Z",
    });
    const draft = createExistingTasksetModelCreateImproveRun({
      profileId: "default",
      taskset,
      modelId: "model_intentional_new",
      preferredBaseModelId: "accounts/fireworks/models/qwen3-8b",
      preferredBaseModel: managedPreference(),
      timestamp: "2026-07-14T00:00:00.000Z",
    });
    const executed = [
      {
        ...first,
        target: {
          ...first.target,
          trainingPlanId: firstPlan.id,
          trainingJobId: "training_job_legacy_first",
        },
      },
      {
        ...second,
        target: {
          ...second.target,
          trainingPlanId: secondPlan.id,
          trainingJobId: "training_job_legacy_second",
        },
      },
    ];
    const state = {
      tasksets: [taskset],
      plans: [firstPlan, secondPlan],
      jobs: [
        job(
          "training_job_legacy_first",
          firstPlan.id,
          "2026-07-12T01:00:00.000Z",
        ),
        job(
          "training_job_legacy_second",
          secondPlan.id,
          "2026-07-13T01:00:00.000Z",
        ),
      ],
      models: [],
      modelBindings: [],
      frontierBaselineRuns: [],
    } as unknown as TrainingStateResponse;

    const models = labWorkproductProjection({
      profile: null,
      training: state,
      runs: [...executed, draft],
    }).filter((workproduct) => workproduct.kind === "model");

    expect(models).toHaveLength(2);
    expect(models.find((model) => model.id === "model_legacy_second")?.runIds)
      .toEqual(expect.arrayContaining([first.id, second.id]));
    expect(models.some((model) => model.id === "model_intentional_new")).toBe(
      true,
    );
  });
});

function job(
  id: string,
  planId: string,
  timestamp: string,
): TrainingJob {
  return {
    schemaVersion: "openpond.trainingJob.v1",
    id,
    planId,
    bundleHash: "bundlehash0001",
    approvalId: `approval_${id}`,
    destinationId: "fireworks",
    status: "succeeded",
    nonProduction: false,
    workerPid: null,
    startedAt: timestamp,
    completedAt: timestamp,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

function lineage(
  id: string,
  modelId: string,
  tasksetId: string,
  jobId: string,
  timestamp: string,
): ModelArtifactLineage {
  return {
    schemaVersion: "openpond.modelArtifactLineage.v1",
    id,
    modelId,
    artifactId: `artifact_${id}`,
    jobId,
    tasksetId,
    tasksetHash: "tasksethash0001",
    graderHash: "graderhash0001",
    planHash: "planhash0001",
    bundleHash: "bundlehash0001",
    recipeHash: "recipehash0001",
    workerVersion: "fireworks-v1",
    trainerVersion: "fireworks-v1",
    importedAt: timestamp,
    frozenEvaluationArtifactId: `evaluation_${id}`,
    promotable: true,
    pinned: false,
    status: "imported",
    rejectedAt: null,
    rejectionReason: null,
    chatConfiguration: {
      schemaVersion: "openpond.localModelChatConfiguration.v1",
      profile: "efficient",
      systemPromptMode: "lean",
      customSystemPrompt: null,
      contextWindowTokens: 1_024,
      maxOutputTokens: 64,
      temperature: 0,
      repetitionPenalty: 1.1,
      noRepeatNgramSize: 3,
      compaction: "when_needed",
      keepWarmSeconds: 300,
      updatedAt: null,
    },
  };
}

function managedPreference() {
  return {
    schemaVersion: "openpond.baseModelPreference.v1" as const,
    modelId: "accounts/fireworks/models/qwen3-8b",
    revision: null,
    tokenizerRevision: null,
    chatTemplateHash: null,
    modelAssetId: null,
    source: "managed" as const,
  };
}
