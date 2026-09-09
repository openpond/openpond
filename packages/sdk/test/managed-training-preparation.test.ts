import { readFile } from "node:fs/promises";
import { contentHash, sha256 } from "@openpond/harness";
import { expect, test } from "vitest";

import { ModelProjectSchema } from "../src/model-projects.js";
import { HarnessRunManifestSchema, ResolvedTrainingBundleManifestSchema } from "../src/training-bundle-contracts.js";
import { prepareManagedTrainingSubmission, type ManagedTrainingPreparationInput } from "../src/managed-training-preparation.js";
import { parseAndVerifyTrainingInputArtifactUpload, parseAndVerifyTrainingJobSubmission } from "../src/training.js";
import type { TrainingEvaluationSource } from "../src/training-evaluation-source.js";

// Failure story: a hosted retry or mutable caller must not replace the recipe,
// approved budget, held-out bytes or inventory under an already selected Run.
test("prepares one immutable manual/hosted submission and rejects changed inputs", async () => {
  const input = await fixture();
  const expected = structuredClone(input);
  const preparing = prepareManagedTrainingSubmission(input);
  input.files[0]!.content = Buffer.from("changed after dispatch").toString("base64");
  const manual = await preparing;
  expect(await parseAndVerifyTrainingJobSubmission(manual.submission)).toEqual(manual.submission);
  expect(await parseAndVerifyTrainingInputArtifactUpload(manual.artifact)).toEqual(manual.artifact);
  expect(manual.submission.idempotencyKey).toBe(`openpond-training-v2:${expected.manifest.contentHash}`);
  expect(manual.artifact.payload).toMatchObject({
    resolvedBundle: { manifest: expected.bundleManifest, files: expected.files },
    validationTasks: expected.evaluationSource.tasks,
  });
  expect(JSON.stringify(manual.submission)).not.toContain("private retained answer");
  const hostedInput = { ...expected, idempotencyKey: "learning-dispatch-fixture" };
  const hosted = await prepareManagedTrainingSubmission(hostedInput);
  expect(hosted).toEqual(await prepareManagedTrainingSubmission(hostedInput));
  expect(hosted.submission.idempotencyKey).toBe(hostedInput.idempotencyKey);
  expect(hosted.submission.source).toEqual(manual.submission.source);
  expect(hosted.submission.job).toEqual(manual.submission.job);
  expect(hosted.artifact.payload).toMatchObject({ idempotencyKey: hostedInput.idempotencyKey });
  await expect(prepareManagedTrainingSubmission(input)).rejects.toThrow("changed before upload");
  await expect(prepareManagedTrainingSubmission({ ...expected, files: [...expected.files, expected.files[0]!] })).rejects.toThrow("inventory changed");
  await expect(prepareManagedTrainingSubmission({ ...expected, recipe: { ...expected.recipe, resourceLimits: { wallTimeMs: 1 } } })).rejects.toThrow("exact approved GRPO recipe");
  await expect(prepareManagedTrainingSubmission({ ...expected, approval: { ...expected.approval, maximumSpendUsd: expected.approval.maximumSpendUsd + 1 } })).rejects.toThrow("spend ceiling");
  await expect(prepareManagedTrainingSubmission({ ...expected, evaluationSource: { ...expected.evaluationSource,
    tasks: [{ ...expected.evaluationSource.tasks[0]!, expectedOutput: { answer: "changed private answer" } }],
  } })).rejects.toThrow("evaluation source differs");
  await expect(prepareManagedTrainingSubmission({ ...expected, project: { ...expected.project, revision: 4 } })).rejects.toThrow("exact Model Project revision");
});

async function fixture(): Promise<ManagedTrainingPreparationInput> {
  const job = await parseAndVerifyTrainingJobSubmission(JSON.parse(await readFile(new URL("../fixtures/training/v2/policy-optimize.valid.json", import.meta.url), "utf8")));
  if (job.job.kind !== "policy_optimize") throw new Error("Expected policy fixture");
  const stamp = job.approval.approvedAt;
  const recipe = { ...job.job.recipe, resourceLimits: { wallTimeMs: 60_000 } };
  const evaluationSource: TrainingEvaluationSource = {
    schemaVersion: "openpond.trainingEvaluationSource.v1", taskset: { id: "held-out", revision: 1, contentHash: "e".repeat(64) },
    tasks: [{ id: "evaluation", clusterKey: "held-out-family", split: "frozen_eval", expectedOutput: { answer: "private retained answer" } }], assets: [],
  };
  const values = [
    ["evaluation-source.json", evaluationSource],
    ["graders.json", { graders: [] }],
    ["environment.json", { environment: { kind: "chat" } }],
    ["dataset/train.json", { tasks: [{ id: "train", clusterKey: "train-family", split: "train" }] }],
    ["tool-contract.json", { toolNames: [] }],
  ] as const;
  const files = values.map(([path, value]) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { path, sha256: sha256(bytes), sizeBytes: bytes.byteLength, encoding: "base64" as const, content: bytes.toString("base64") };
  });
  const bundleContent = { schemaVersion: "openpond.resolvedTrainingBundle.v1", projection: "trainer",
    harnessRelease: job.source.harnessRelease, datasetRelease: job.source.dataset, evidenceSetRelease: null,
    files: files.map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes })),
  };
  const bundleManifest = ResolvedTrainingBundleManifestSchema.parse({ ...bundleContent, contentHash: contentHash(bundleContent) });
  const baseModel = { ...job.job.baseModel, chatTemplateHash: sha256("fixture chat template") };
  const project = ModelProjectSchema.parse({
    schemaVersion: "openpond.modelProject.v2", id: job.source.modelProject.portableProjectId, profileId: "team", revision: 3,
    name: "Prepared model", objective: null, defaultBaseModel: baseModel, defaultDestinationId: "openpond_managed",
    trainingSetup: { baseModel, recipe, tasksetRef: job.source.taskset, evaluationTasksetRef: evaluationSource.taskset },
    hosted: { apiOrigin: "https://staging-api.openpond.ai", schemaVersion: "openpond.hostedModelProjectLink.v1", teamId: "team",
      projectId: job.source.modelProject.id, portableProjectId: job.source.modelProject.portableProjectId,
      revision: 1, etag: job.source.modelProject.contentHash, syncedSourceRevision: 3, syncedAt: stamp, tasksets: [] },
    createdAt: stamp, updatedAt: stamp,
  });
  const manifestContent = {
    schemaVersion: "openpond.harnessRunManifest.v1", id: "manifest", harnessRelease: job.source.harnessRelease,
    datasetRelease: job.source.dataset, evidenceSets: [],
    model: { source: baseModel.modelId, revision: baseModel.revision, artifactHash: null, tokenizerRevision: baseModel.tokenizerRevision, chatTemplateHash: baseModel.chatTemplateHash },
    recipe: { method: "grpo", version: "openpond.trainingRecipe.v1", configHash: contentHash(recipe) },
    runtimeTarget: { adapterId: "managed", placement: "remote", capabilityReceipt: "a".repeat(64), runtimeVersion: "1", dataPlane: null },
    computeTarget: { adapterId: "managed", kind: "managed", deviceOrPool: "gpu", capabilityReceipt: "a".repeat(64), provider: "openpond" },
    engine: { adapterId: "managed", workerVersion: "1", workerImageDigest: null, upstreamRevision: "fixture", capabilityReceipt: "a".repeat(64) },
    resolvedBundleHash: bundleManifest.contentHash, secretLeaseRefs: [],
    approval: { approvalHash: job.approval.approvalHash, approvedAt: stamp, maximumSpendUsd: job.budget.maximumSpendUsd }, createdAt: stamp,
  };
  return { project, recipe, taskset: job.source.taskset, files, bundleManifest, evaluationSource,
    manifest: HarnessRunManifestSchema.parse({ ...manifestContent, contentHash: contentHash(manifestContent) }),
    rewardSource: job.job.rewardSource, resumeFrom: null, approval: job.approval,
  };
}
