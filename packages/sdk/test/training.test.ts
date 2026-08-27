import { describe, expect, it, vi } from "vitest";

import {
  OPENPOND_TRAINING_MEDIA_TYPE,
  TrainingApiErrorSchema,
  TrainingJobSubmissionSchema,
  canonicalJson,
  createTrainingClient,
  parseAndVerifyTrainingJobSubmission,
  trainingJobSubmissionHash,
} from "../src/training.js";

const HASH = "b".repeat(64);
const NOW = "2026-08-26T20:00:00.000Z";

function submission() {
  return {
    schemaVersion: "openpond.trainingJobSubmission.v2" as const,
    idempotencyKey: "submit-project-1-r3",
    name: "Support model training",
    source: {
      modelProject: {
        id: "hosted-project-1",
        portableProjectId: "project-1",
        revision: 3,
        contentHash: HASH,
      },
      harnessRunManifest: { id: "manifest-1", contentHash: HASH },
      harnessRelease: { id: "harness-1", contentHash: HASH },
      taskset: { id: "taskset-1", revision: 2, contentHash: HASH },
      tasksetRelease: { id: "taskset-release-1", contentHash: HASH },
      dataset: { id: "dataset-1", contentHash: HASH },
      evidenceSets: [],
    },
    job: {
      kind: "policy_optimize" as const,
      baseModel: {
        schemaVersion: "openpond.baseModelPreference.v1" as const,
        modelId: "model-1",
        revision: "rev-1",
        tokenizerRevision: "tok-1",
        chatTemplateHash: "template-1",
        modelAssetId: null,
        source: "managed" as const,
      },
      recipe: {
        schemaVersion: "openpond.rftRecipe.v1",
        method: "grpo" as const,
        parameterization: "lora" as const,
      },
      rewardSource: {
        kind: "deterministic" as const,
        grader: { id: "grader-1", contentHash: HASH },
        composer: null,
      },
      resumeFrom: null,
    },
    requestedCapabilities: [],
    budget: { maximumSpendUsd: 10, maximumWallSeconds: 3_600 },
    approval: {
      approvalHash: HASH,
      approvedAt: NOW,
      exportApproved: true,
      maximumSpendUsd: 10,
      retentionDays: 7,
      region: null,
    },
    contentHash: HASH,
  };
}

function job() {
  return {
    schemaVersion: "openpond.trainingJob.v2",
    id: "job-1",
    teamId: "team-1",
    kind: "policy_optimize",
    modelProjectId: "hosted-project-1",
    portableProjectId: "project-1",
    sourceProjectRevision: 3,
    submissionHash: HASH,
    state: "queued",
    phase: "admission",
    version: 0,
    progress: 0,
    accruedSpendUsd: 0,
    terminalReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

describe("Training SDK contracts", () => {
  it("binds every immutable Job to an exact Project revision and approval", () => {
    const parsed = TrainingJobSubmissionSchema.parse(submission());
    expect(parsed.source.modelProject).toEqual({
      id: "hosted-project-1",
      portableProjectId: "project-1",
      revision: 3,
      contentHash: HASH,
    });
    expect(parsed.approval.maximumSpendUsd).toBe(parsed.budget.maximumSpendUsd);
  });

  it("rejects an approval for a different spend ceiling", () => {
    expect(() =>
      TrainingJobSubmissionSchema.parse({
        ...submission(),
        approval: { ...submission().approval, maximumSpendUsd: 11 },
      }),
    ).toThrow("Approved spend must equal");
  });

  it("lists Jobs by Project through the public API", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        schemaVersion: "openpond.trainingJobPage.v2",
        jobs: [job()],
        nextCursor: "cursor-2",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createTrainingClient({
      baseUrl: "https://api.openpond.test",
      fetch,
    });
    const page = await client.listJobs({
      modelProjectId: "hosted-project-1",
      limit: 25,
    });
    expect(page.jobs).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor-2");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openpond.test/v1/training/jobs?modelProjectId=hosted-project-1&limit=25",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: OPENPOND_TRAINING_MEDIA_TYPE }),
      }),
    );
  });

  it("canonicalizes object keys and verifies the submission content hash", async () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null } })).toBe(
      '{"a":{"b":null,"y":true},"z":1}',
    );
    const unsigned = submission();
    const contentHash = await trainingJobSubmissionHash(unsigned);
    await expect(
      parseAndVerifyTrainingJobSubmission({ ...unsigned, contentHash }),
    ).resolves.toMatchObject({ contentHash });
    await expect(
      parseAndVerifyTrainingJobSubmission(unsigned),
    ).rejects.toMatchObject({
      code: "content_hash_mismatch",
    });
  });

  it("requires strict versioned error envelopes", () => {
    expect(() => TrainingApiErrorSchema.parse({ error: "failed" })).toThrow();
    expect(TrainingApiErrorSchema.parse({
      schemaVersion: "openpond.trainingApiError.v2",
      code: "budget_exceeded",
      message: "Budget exceeded.",
      retryable: false,
      requestId: null,
      details: {},
    }).code).toBe("budget_exceeded");
  });
});
