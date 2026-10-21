import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash, sha256 } from "@openpond/harness";
import { expect, test } from "vitest";

import { ModelProjectSchema } from "../src/model-projects.js";
import { HarnessRunManifestSchema, ResolvedTrainingBundleManifestSchema } from "../src/training-bundle-contracts.js";
import { prepareManagedTrainingSubmission, type ManagedTrainingPreparationInput } from "../src/managed-training-preparation.js";
import { parseAndVerifyTrainingInputArtifactUpload, parseAndVerifyTrainingJobSubmission } from "../src/training.js";
import type { TrainingEvaluationSource } from "../src/training-evaluation-source.js";
import { bindTasksetExecutionReleases, createEnvironmentRelease, createVerifierSetRelease } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { createTasksetPackage } from "../src/taskset-packages.js";
import { prepareOrdinaryTasksetQualification } from "../src/training-bundle.js";

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

// Failure story: a validation-only qualification must retain its private grader
// and its transitive private modules, and cannot be replayed as optimizer work.
test("qualifies an ordinary private package without inventing training or held-out data", async () => {
  const ordinary = await fixture();
  const text = "import {matches} from './support/matches.mjs'; export function verify(input) { const passed = matches(input.output, input.task.expectedOutput.answer); return {score: passed ? 1 : 0, passed}; }";
  const asset = { id: "private-verifier", path: "verifiers/answer.mjs", mediaType: "text/javascript", visibility: "verifier" as const,
    sizeBytes: Buffer.byteLength(text), contentHash: sha256(text) };
  const supportFiles = [
    ["verifiers/support/matches.mjs", "export {matches} from './compare.mjs';"],
    ["verifiers/support/compare.mjs", "import {isDeepStrictEqual} from 'node:util'; export const matches=isDeepStrictEqual;"],
    ["verifiers/unrelated.mjs", "throw new Error('Unrelated module must not be materialized');"],
  ].map(([path, text]) => ({ asset: { id: path!, path: path!, mediaType: "text/javascript", visibility: "verifier" as const,
    sizeBytes: Buffer.byteLength(text!), contentHash: sha256(text!) }, base64: Buffer.from(text!).toString("base64") }));
  const taskFiles = ["first", "second"].map(id => ({ asset: {
    id: `${id}-input`, path: `inputs/${id}.txt`, mediaType: "text/plain", visibility: "policy" as const,
    sizeBytes: Buffer.byteLength(id), contentHash: sha256(id),
  }, base64: Buffer.from(id).toString("base64") }));
  const environment = createEnvironmentRelease({ schemaVersion: "openpond.environmentRelease.v1", id: "qualification-env", revision: 1,
    contract: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "text", stateful: false, deterministicSeeds: true,
      lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 1_000 },
    actionSchemaRef: null, observationSchemaRef: null, stateSchemaRef: null, artifactCollection: { maxArtifacts: 1, maxTotalBytes: 1 }, adapterConformanceHashes: {}, metadata: {} });
  const verifierSet = createVerifierSetRelease({ schemaVersion: "openpond.verifierSetRelease.v1", id: "qualification-verifiers", revision: 1,
    graders: [{ id: "answer", version: "1", kind: "custom_verifier", weight: 1, hardGate: true, rewardEligible: true, privileged: true,
      verifierRef: asset, timeoutMs: 1_000, networkPolicy: "none" }], isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1_000 }, calibrationReceiptRefs: [], metadata: {} });
  const taskContent = { schemaVersion: "openpond.tasksetRelease.v2", id: "qualification-tasks", revision: 1,
    policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: ["answer"], connectedAppScopes: [] },
    environment: environment.contract, tools: [], capabilities: [], graders: verifierSet.graders,
    tasks: ["first", "second"].map(id => ({ id, clusterKey: "same-family", split: "validation", input: { prompt: id }, expectedOutput: { answer: "private retained answer" },
      policyVisibleContext: {}, privilegedContextRef: null, artifactRefs: [taskFiles.find(file => file.asset.id === `${id}-input`)!.asset], tags: [] })), metadata: { ordinaryAuthoring: { instructions: "Answer the supplied question." } } };
  const taskset = bindTasksetExecutionReleases({ taskset: TasksetReleaseSchema.parse({ ...taskContent, contentHash: contentHash(taskContent) }), environment, verifierSet });
  const source = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, environment, verifierSet, files: [{ asset, base64: Buffer.from(text).toString("base64") }, ...supportFiles, ...taskFiles] });
  const project = ModelProjectSchema.parse({ ...ordinary.project, trainingSetup: { ...ordinary.project.trainingSetup,
    baseModel: { ...ordinary.project.trainingSetup.baseModel, revision: "a".repeat(40), tokenizerRevision: "a".repeat(40) },
    tasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash }, evaluationTasksetRef: null } });
  const preparation = { package: source, qualificationTaskId: "second", modelProject: project, modelRunId: "qualification",
    runtime: ordinary.manifest.runtimeTarget, compute: ordinary.manifest.computeTarget, engine: ordinary.manifest.engine,
    harnessRelease: ordinary.manifest.harnessRelease, openpondRelease: "fixture", workerProtocol: "fixture",
    approval: { ...ordinary.approval, approvedAt: ordinary.manifest.approval.approvedAt } };
  const prepared = await prepareOrdinaryTasksetQualification(preparation);
  expect(prepared.submission.job).toMatchObject({ executionMode: "qualification", resumeFrom: null });
  expect(prepared.submission.source.taskset).toEqual(project.trainingSetup.tasksetRef);
  expect(prepared.submission.source.evaluation).toBeUndefined();
  expect(prepared.artifact.payload).toMatchObject({ executionMode: "qualification", validationTasks: [], validationAssets: [] });
  const dataset = JSON.parse(Buffer.from(prepared.bundle.assets.get("dataset/qualification.json")!).toString());
  expect(dataset.selectedTaskId).toBe("second");
  expect(dataset.tasks.map((task: { metadata: { portableTaskRecord: unknown } }) => task.metadata.portableTaskRecord)).toEqual([taskset.tasks[1]]);
  expect(JSON.parse(Buffer.from(prepared.bundle.assets.get("qualification-source.json")!).toString())).toEqual(source);
  expect(JSON.parse(Buffer.from(prepared.bundle.assets.get("environment.json")!).toString()).environment.metadata.policySystemPrompt)
    .toBe(taskContent.metadata.ordinaryAuthoring.instructions);
  expect(prepared.bundle.assets.has("inputs/first.txt")).toBe(false);
  expect(Buffer.from(prepared.bundle.assets.get("inputs/second.txt")!).toString()).toBe("second");
  expect(prepared.bundle.assets.has("dataset/train.json")).toBe(false);
  expect(prepared.bundle.assets.has("evaluation-source.json")).toBe(false);
  expect(JSON.stringify(prepared.submission)).not.toContain("private retained answer");
  const grading = JSON.parse(Buffer.from(prepared.bundle.assets.get("reward-binding.json")!).toString());
  expect(grading.assets.map((entry: { asset: { path: string } }) => entry.asset.path).sort()).toEqual([
    asset.path, supportFiles[0]!.asset.path, supportFiles[1]!.asset.path,
  ].sort());
  const directory = await mkdtemp(join(tmpdir(), "qualification-grader-"));
  try {
    for (const entry of grading.assets) {
      expect(sha256(entry.text)).toBe(entry.asset.contentHash);
      const destination = join(directory, entry.asset.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, entry.text);
    }
    const verifier = await import(pathToFileURL(join(directory, asset.path)).href);
    expect(verifier.verify({ task: taskset.tasks[1], output: "private retained answer" })).toEqual({ score: 1, passed: true });
    expect(verifier.verify({ task: taskset.tasks[1], output: "wrong" })).toEqual({ score: 0, passed: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
  for (const visibility of ["missing", "policy", "host_private"] as const) {
    const files = source.files.flatMap(file => file.asset.id !== supportFiles[1]!.asset.id ? [file]
      : visibility === "missing" ? [] : [{ ...file, asset: { ...file.asset, visibility } }]);
    const { contentHash: _packageHash, ...sourceContent } = source;
    const changedSource = createTasksetPackage({ ...sourceContent, files });
    await expect(prepareOrdinaryTasksetQualification({ ...preparation, package: changedSource }))
      .rejects.toThrow("declared verifier-visible JavaScript asset");
  }
  const payload = prepared.artifact.payload as { resolvedBundle: { files: ManagedTrainingPreparationInput["files"] } };
  const replay = { ...ordinary, project, manifest: prepared.bundle.manifest, bundleManifest: prepared.bundle.resolvedBundleManifest,
    files: payload.resolvedBundle.files, evaluationSource: undefined };
  await expect(prepareManagedTrainingSubmission(replay)).rejects.toThrow("execution mode");
  await expect(prepareManagedTrainingSubmission({ ...ordinary, executionMode: "qualification" })).rejects.toThrow("execution mode");
  await expect(prepareManagedTrainingSubmission({ ...replay, executionMode: "qualification", bundleManifest: ordinary.bundleManifest })).rejects.toThrow("execution mode");
});

async function fixture(): Promise<ManagedTrainingPreparationInput & { evaluationSource: TrainingEvaluationSource }> {
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
