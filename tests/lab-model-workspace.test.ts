import { describe, expect, test } from "vitest";
import {
  ModelRunSchema,
  type TrainingJob,
  type TrainingStateResponse,
} from "@openpond/contracts";

import { modelRunEntries } from "../apps/web/src/components/labs/LabModelWorkspace";
import { labModelJobs } from "../apps/web/src/components/labs/lab-models";
import type { LabWorkproductSummary } from "../apps/web/src/components/labs/lab-workproducts";
import {
  destinationLabel,
  formatDuration,
} from "../apps/web/src/components/training/training-model-data";

const TIMESTAMP = "2026-07-28T12:00:00.000Z";
const HASH = "a".repeat(64);

describe("Lab Model workspace organization", () => {
  test("merges lifecycle and execution records into one run row", () => {
    const linkedJob = trainingJob("training_job_linked", {
      modelRunId: "model_run_linked",
    });
    const standaloneJob = trainingJob("training_job_standalone");
    const lifecycleRun = ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: "model_run_linked",
      modelId: "model_fixture",
      modelVersionId: "model_version_base",
      profileId: "default",
      kind: "training",
      status: "failed",
      method: "grpo",
      destinationId: "openpond_managed",
      taskset: {
        id: "taskset_fixture",
        revision: 1,
        contentHash: HASH,
      },
      quote: {
        maximumSpendUsd: 1,
        hourlyCostUsd: null,
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: "Fixture failure",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const entries = modelRunEntries(
      [linkedJob, standaloneJob],
      [],
      [lifecycleRun]
    );

    expect(entries.map((entry) => entry.key).sort()).toEqual([
      "job:training_job_standalone",
      "model-run:model_run_linked",
    ]);
    expect(
      entries.find((entry) => entry.key === "model-run:model_run_linked")?.job
        ?.id
    ).toBe(linkedJob.id);
  });

  test("associates portable execution jobs through their Model Run metadata", () => {
    const workproduct = modelWorkproduct();
    const linkedJob = trainingJob("training_job_linked", {
      modelRunId: "model_run_linked",
    });
    const lifecycleRun = ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: "model_run_linked",
      modelId: workproduct.id,
      modelVersionId: "model_version_base",
      profileId: "default",
      kind: "training",
      status: "failed",
      method: "grpo",
      destinationId: "openpond_managed",
      taskset: {
        id: "taskset_fixture",
        revision: 1,
        contentHash: HASH,
      },
      quote: {
        maximumSpendUsd: 1,
        hourlyCostUsd: null,
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: "Fixture failure",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const state = {
      plans: [],
      jobs: [linkedJob],
      modelRuns: [lifecycleRun],
    } as unknown as TrainingStateResponse;

    expect(labModelJobs(workproduct, [], state).map((job) => job.id)).toEqual([
      linkedJob.id,
    ]);
  });
});

function trainingJob(
  id: string,
  metadata: Record<string, unknown> = {}
): TrainingJob {
  return {
    schemaVersion: "openpond.trainingJob.v1",
    id,
    planId: "training_plan_fixture",
    bundleHash: "bundlehash0001",
    approvalId: `approval_${id}`,
    destinationId: "openpond_managed",
    status: "failed",
    nonProduction: false,
    workerPid: null,
    startedAt: TIMESTAMP,
    completedAt: TIMESTAMP,
    error: "Fixture failure",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    metadata,
  };
}

function modelWorkproduct(): LabWorkproductSummary {
  return {
    key: "model:model_fixture",
    kind: "model",
    id: "model_fixture",
    name: "Fixture Model",
    description: "Fixture Model",
    status: "Ready",
    updatedAt: TIMESTAMP,
    path: null,
    enabled: true,
    runIds: [],
    conversationId: null,
    tasksetId: "taskset_fixture",
    trainingRunCount: 1,
    evaluationStatus: "not_run",
    useActionId: null,
    ownerProfileId: "default",
  };
}
