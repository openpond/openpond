import { describe, expect, test } from "vitest";

import {
  createExistingTasksetModelCreateImproveRun,
  createTasksetAuthoringCreateImproveRun,
} from "../apps/server/src/training/model-create-improve";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("Model and Dataset association", () => {
  test("creates a separate Model draft over an immutable existing Dataset", () => {
    const taskset = tasksetFixture({ ready: true });
    const run = createExistingTasksetModelCreateImproveRun({
      profileId: taskset.profileId,
      taskset,
      preferredBaseModelId: "accounts/fireworks/models/qwen3-8b",
      preferredBaseModel: managedPreference(),
      timestamp: "2026-07-18T12:00:00.000Z",
    });

    expect(run.state).toBe("ready");
    expect(run.target).toMatchObject({
      kind: "model",
      id: expect.stringMatching(/^model_/),
      displayName: taskset.name,
      trainingPlanId: null,
      trainingJobId: null,
      artifactId: null,
    });
    expect(run.target.id).not.toBe(taskset.id);
    expect(run.tasksetRef).toMatchObject({
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    });
    expect(run.metadata).toMatchObject({
      source: "existing_dataset_model",
      preferredBaseModelId: "accounts/fireworks/models/qwen3-8b",
      preferredBaseModel: managedPreference(),
    });
    expect(run.sourceRefs).toContain(taskset.id);
    expect(run.plan).toBeNull();
    expect(run.externalExecutionRefs).toEqual([]);
  });

  test("keeps a Dataset-only authoring run target-neutral", () => {
    const run = createTasksetAuthoringCreateImproveRun({
      profileId: "default",
      objective: "Create an approved billing Dataset.",
      sourceIds: [],
      resourceIntent: "dataset",
      targetIntent: {
        kind: null,
        id: null,
        displayName: null,
        operation: "create",
      },
      timestamp: "2026-07-18T12:00:00.000Z",
    });

    expect(run.target.kind).toBe("unselected");
    expect(run.metadata).toMatchObject({
      resourceIntent: "dataset",
      preferredBaseModelId: null,
    });
  });
});

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
