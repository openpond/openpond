import { describe, expect, it, vi } from "vitest";

import {
  OPENPOND_TRAINING_MEDIA_TYPE,
  TrainingApiErrorSchema,
  TrainingInputArtifactSchema,
  TrainingJobSubmissionSchema,
  canonicalJson,
  createTrainingClient,
  parseAndVerifyTrainingJobSubmission,
  parseAndVerifyTrainingInputArtifactUpload,
  parseAndVerifyTrainingExecutionReceipt,
  trainingExecutionReceiptHash,
  trainingInputArtifactUploadHash,
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
  it("verifies receipt identity, authority, Job binding, hash, and cleanup", async () => {
    const receipt = {
      schemaVersion: "openpond.trainingExecutionReceipt.v2" as const,
      id: "receipt-1",
      teamId: "team-1",
      jobId: "job-1",
      submissionHash: HASH,
      manifestHash: HASH,
      recipeHash: HASH,
      capabilityHash: HASH,
      runtimeRelease: { id: "runtime-1", contentHash: HASH },
      inputs: [],
      outputs: [],
      spendUsd: 0.5,
      durationSeconds: 60,
      cleanupComplete: true,
      issuer: "sandbox-managed-training",
      issuedAt: NOW,
      signature: null,
    };
    const contentHash = await trainingExecutionReceiptHash(receipt);
    await expect(parseAndVerifyTrainingExecutionReceipt(receipt, {
      id: receipt.id,
      contentHash,
      teamId: receipt.teamId,
      jobId: receipt.jobId,
    })).resolves.toEqual(receipt);
    await expect(parseAndVerifyTrainingExecutionReceipt(
      { ...receipt, cleanupComplete: false },
      {
        id: receipt.id,
        contentHash: await trainingExecutionReceiptHash({
          ...receipt,
          cleanupComplete: false,
        }),
      },
    )).rejects.toMatchObject({ code: "execution_cleanup_incomplete" });
  });

  it("stages a bounded content-addressed portable input without starting a Job", async () => {
    const unsigned = {
      schemaVersion: "openpond.trainingInputArtifactUpload.v2" as const,
      kind: "portable_training_bundle" as const,
      idempotencyKey: "stage-manifest-1",
      sourceManifest: { id: "manifest-1", contentHash: HASH },
      payload: { schemaVersion: "openpond.managedRlPortableSubmission.v1" },
    };
    const upload = {
      ...unsigned,
      contentHash: await trainingInputArtifactUploadHash(unsigned),
    };
    await expect(parseAndVerifyTrainingInputArtifactUpload(upload)).resolves.toEqual(upload);

    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        artifact: {
          schemaVersion: "openpond.trainingInputArtifact.v2",
          kind: upload.kind,
          sourceManifest: upload.sourceManifest,
          artifactRef: "r2://team/training-inputs/hash.json",
          contentHash: upload.contentHash,
          sizeBytes: 128,
          createdAt: NOW,
        },
      }), { status: 201 }),
    );
    const client = createTrainingClient({
      baseUrl: "https://api.openpond.test",
      fetch,
    });
    await expect(client.stageArtifact(upload)).resolves.toEqual(
      TrainingInputArtifactSchema.parse({
        schemaVersion: "openpond.trainingInputArtifact.v2",
        kind: upload.kind,
        sourceManifest: upload.sourceManifest,
        artifactRef: "r2://team/training-inputs/hash.json",
        contentHash: upload.contentHash,
        sizeBytes: 128,
        createdAt: NOW,
      }),
    );
  });

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

  it("retries transient read failures without replaying mutations", async () => {
    const readFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 500 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: job() }), { status: 200 }));
    const readClient = createTrainingClient({
      baseUrl: "https://api.openpond.test",
      fetch: readFetch,
    });
    await expect(readClient.getJob("job-1")).resolves.toEqual(job());
    expect(readFetch).toHaveBeenCalledTimes(2);

    const mutationFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 500 }),
    );
    const mutationClient = createTrainingClient({
      baseUrl: "https://api.openpond.test",
      fetch: mutationFetch,
    });
    const unsigned = submission();
    const validSubmission = {
      ...unsigned,
      contentHash: await trainingJobSubmissionHash(unsigned),
    };
    await expect(mutationClient.createJob(validSubmission)).rejects.toMatchObject({
      code: "invalid_error_response",
    });
    expect(mutationFetch).toHaveBeenCalledTimes(1);
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
