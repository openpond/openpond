import { expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TasksetSourceRefSchema, TrainingDestinationCapabilitiesSchema } from "@openpond/contracts";
import { createLearningTextAsset, learningRef, sealLearningContent, TaskDefinitionSchema } from "@openpond/evals/learning";
import { ModelStarterSchema, createModelStarterCreationRequest, modelStarterPrivacyContentHash, validateResolvedModelStarter } from "openpond-sdk/model-starters";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { withTempDirectory } from "./helpers/temp-directory.js";
import starterImportFixture from "./fixtures/model-starter-import.json";
import { prepareModelStarterTaskset } from "../apps/server/src/training/model-starter-taskset.js";
import { createModelStarterCreationService } from "../apps/server/src/training/model-starter-creation-service.js";
import { createModelStarterRuntime } from "../apps/server/src/training/model-starter-runtime.js";
import { projectBaseModelCandidates } from "../apps/server/src/training/base-model-candidates.js";
import { openStorageDatabase } from "@openpond/persistence";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service.js";
import { attemptFixture, sftRecipeFixture } from "./helpers/training-fixtures.js";
import { materializePortableTasksetRelease, computeTasksetHash } from "@openpond/taskset-sdk";
import { buildTasksetTrainingBundle } from "@openpond/training-sdk";
import { resolveTasksetTrainingReward, resolveManagedTasksetReward } from "../apps/server/src/training/taskset-reward-binding.js";
import { requireReleasedTaskset } from "../apps/server/src/training/local-taskset-release.js";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { compileDesktopHarnessContext } from "../apps/server/src/training/portable-evals-adapter.js";

// A valid release reference alone must never admit missing or altered private code.
it("exports verified private Reward assets separately from policy task assets", async () => withTempDirectory("starter-private-export-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const saved = await store.saveModelStarterCreation(input);
    expect(saved.trainingSetup.managedRolloutPlacement).toBe("remote");
    const taskset = (await store.getTaskset(saved.trainingSetup.tasksetRef!.id))!;
    const resolved = await resolveTasksetTrainingReward(store, taskset);
    expect(await resolveManagedTasksetReward(store, taskset, { placement: "remote", hasLearnedPreferenceReward: false })).toEqual(resolved);
    await expect(resolveManagedTasksetReward(store, taskset, { placement: "local", hasLearnedPreferenceReward: false })).rejects.toThrow("additional managed execution adapter");
    await expect(resolveManagedTasksetReward(store, taskset, { placement: "remote", hasLearnedPreferenceReward: true })).rejects.toThrow("additional managed execution adapter");
    const previouslySaved = { ...taskset, metadata: { ...taskset.metadata } };
    delete previouslySaved.metadata.rewardExecution;
    previouslySaved.contentHash = computeTasksetHash(previouslySaved);
    const published = await requireReleasedTaskset({ releaseForTaskset: async () => null }, previouslySaved, store);
    expect(published.metadata.rewardExecution).toEqual(resolved.rewardExecution);
    // Admission must resolve reference-only authoring records without changing
    // the published verifier graph or accepting a substituted binding.
    const admission = { taskset: previouslySaved, tasksetRelease: published, model: { providerId: "openpond", modelId: "fixture" } };
    const context = compileDesktopHarnessContext({ ...admission, rewardExecution: resolved.rewardExecution });
    expect(context.tasksetRelease.contentHash).toBe(published.contentHash);
    expect(context.verifierSetRelease.contentHash).toBe(published.verifierSetRelease!.contentHash);
    expect(() => compileDesktopHarnessContext(admission)).toThrow("exact published Reward binding");
    expect(() => compileDesktopHarnessContext({ ...admission, rewardExecution: { ...resolved.rewardExecution!, binding: { ...resolved.rewardExecution!.binding, contentHash: "0".repeat(64) } } })).toThrow("exact published Reward binding");
    const hash = "a".repeat(64);
    const build = (verifierAssets = resolved.verifierAssets) => buildTasksetTrainingBundle({
      taskset, rewardExecution: resolved.rewardExecution, verifierAssets,
      modelProject: { ...saved, trainingSetup: { ...saved.trainingSetup, recipe: sftRecipeFixture(), baseModel: { ...input.request.startingModel, revision: "pinned-model", tokenizerRevision: "pinned-tokenizer", chatTemplateHash: hash } } },
      modelRunId: "starter-private-export", runtime: { adapterId: "local-harness", placement: "local", capabilityReceipt: hash, runtimeVersion: "1", dataPlane: null },
      compute: { adapterId: "openpond-managed", kind: "local", deviceOrPool: "cpu", capabilityReceipt: hash, provider: null },
      engine: { adapterId: "local-training-worker", workerVersion: "1", workerImageDigest: null, upstreamRevision: "test", capabilityReceipt: hash },
      approval: { approvalHash: hash, approvedAt: input.createdAt, maximumSpendUsd: 0 }, openpondRelease: "test", workerProtocol: "test",
      harnessRelease: { id: "test-harness", contentHash: hash }, tasksetRelease: { id: "test-taskset", contentHash: hash },
    });
    const bundle = build();
    const privateFile = JSON.parse(new TextDecoder().decode(bundle.assets.get("reward-binding.json")));
    expect(privateFile).toEqual({ kind: "reward_binding_v1", ...resolved.rewardExecution, assets: input.package.assets });
    expect(new TextDecoder().decode(bundle.assets.get("dataset/train.json"))).not.toContain(JSON.stringify(input.package.assets[0]!.text).slice(1, -1));
    expect(bundle.resolvedBundleManifest.files.some(file => file.path === "reward-binding.json")).toBe(true);
    expect(() => build([])).toThrow("private verifier asset");
    expect(() => build(resolved.verifierAssets.map(asset => ({ ...asset, text: `${asset.text}\n// changed` })))).toThrow();
  } finally { await store.close(); }
}));

// Hosted publication must preserve composition and reject a substituted Reward.
it("preserves the exact starter Reward binding in the portable release", async () => {
  const input = await starterInput();
  const { taskset } = prepareModelStarterTaskset(input);
  const portable = materializePortableTasksetRelease({ taskset, adapterId: "starter-test" });
  expect(portable.tasksetRelease.metadata.rewardExecution).toEqual({ binding: input.package.rewardBinding, rewards: input.package.rewards });
  expect(portable.tasksetRelease.metadata.learning).toBeUndefined();
  expect(() => materializePortableTasksetRelease({ taskset: { ...taskset, metadata: { ...taskset.metadata, rewardBinding: { ...input.package.rewardBinding, contentHash: "0".repeat(64) } } }, adapterId: "starter-test" })).toThrow("exact published Reward binding");
  expect(() => materializePortableTasksetRelease({ taskset, adapterId: "starter-test", rewardExecution: { binding: input.package.rewardBinding, rewards: input.package.rewards.map(reward => ({ ...reward, name: "Tampered" })) } })).toThrow();
});

// Authored starter checks use the same public binding executor as learning
// batches, including rejection of wrong output and an attributable composition.
it("grades an imported starter through its published Reward binding", async () => withTempDirectory("starter-grading-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const saved = await store.saveModelStarterCreation(input);
    const taskset = (await store.getTaskset(saved.trainingSetup.tasksetRef!.id))!;
    const task = taskset.tasks[0]!;
    const service = createTaskEvaluationService({ store, storeDir: home });
    const correct = await service.grade({ tasksetId: taskset.id, taskId: task.id, attempt: attemptFixture({ id: "starter-correct", tasksetId: taskset.id, taskId: task.id, split: task.split, output: task.expectedOutput! }) });
    expect(correct).toMatchObject({ score: 1, passed: true, rewardEligible: true });
    expect(correct.rewardComposition).toBeDefined();
    const wrong = await service.grade({ tasksetId: taskset.id, taskId: task.id, attempt: attemptFixture({ id: "starter-wrong", tasksetId: taskset.id, taskId: task.id, split: task.split, output: { ...task.expectedOutput, invoiceNumber: "WRONG" } }) });
    expect(wrong).toMatchObject({ score: 0, passed: false, rewardEligible: true });
  } finally { await store.close(); }
}));

// Existing v59 installations must gain starter receipts without losing models.
it("upgrades an existing local database before reading starter operation receipts", async () => withTempDirectory("starter-upgrade-", async home => {
  const input = await starterInput();
  const original = new SqliteStore(home);
  const saved = await original.saveModelStarterCreation(input);
  const databasePath = original.storePath;
  await original.close();
  const database = openStorageDatabase(databasePath);
  try { database.exec("DROP TABLE model_starter_creation_operations; PRAGMA user_version = 59;"); }
  finally { database.close(); }
  const upgraded = new SqliteStore(home);
  try {
    expect(await upgraded.findModelStarterCreation(input.request)).toBeNull();
    expect(await upgraded.getModelProject(saved.id)).toEqual(saved);
  } finally { await upgraded.close(); }
}));

// Setup checks validate authoring without requiring training availability, and
// must not create resources or silently replace an unavailable training method.
it("checks an import without persistence and rejects unavailable starting models", async () => withTempDirectory("starter-check-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const service = createModelStarterCreationService({ store, home, catalog: { resolve: async () => input } });
    const unavailable = await service.check(input.request, "profile", []);
    expect(unavailable.canSave).toBe(false);
    expect(unavailable.findings).toContainEqual(expect.objectContaining({ code: "model_base_unavailable", severity: "error" }));
    const destination = TrainingDestinationCapabilitiesSchema.parse({ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId: "openpond_managed", available: true, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: [input.request.startingModel.modelId], maxDatasetBytes: null, environmentPlacements: ["remote"], nonProduction: false, unavailableReason: null, checkedAt: input.createdAt });
    const { schemaVersion: _schema, operationId: _operation, ...intent } = input.request;
    const request = await createModelStarterCreationRequest({ ...intent, startingModel: projectBaseModelCandidates({ destinations: [destination] })[0]!.preference });
    const report = await service.check(request, "profile", [destination]);
    expect(report.canSave).toBe(true);
    const unsupported = await service.check(request, "profile", [{ ...destination, methods: [] }]);
    expect(unsupported.canSave).toBe(true);
    expect(unsupported.findings).toContainEqual(expect.objectContaining({ code: "starter_method_unavailable", severity: "warning" }));
    expect(await store.getModelProject(request.modelId)).toBeNull();
    expect(await store.findModelStarterCreation(request)).toBeNull();
    await expect(service.check(request, "other", [destination])).rejects.toThrow("authorized Profile");
    const saved = await service.create(request, "profile");
    expect(saved.trainingSetup.method).toBe("sft");
    expect((await store.getTaskset(saved.trainingSetup.tasksetRef!.id))?.readiness).toBeNull();
  } finally { await store.close(); }
}));

// Importing curated examples must preserve held-out splits and exact verifier
// bytes, and must never invent approval of an unreviewed supervised target.
it("publishes a model-owned authored Taskset with only explicitly approved training targets", async () => {
  const input = await starterInput();
  const { package: resolved, request, source } = input;
  const task = resolved.taskset.tasks[0]!;
  const result = prepareModelStarterTaskset(input);
  expect(prepareModelStarterTaskset(input)).toEqual(result);
  expect(result.taskset.tasks.map(task => [task.id, task.split, task.clusterKey])).toEqual(resolved.taskset.tasks.map(task => [task.id, task.split, task.clusterKey]));
  expect(result.taskset.learningSignals.demonstrations.map(signal => signal.taskId)).toEqual([task.id]);
  expect(result.taskset.readiness).toBeNull();
  expect(result.taskset.status).toBe("needs_review");
  expect(result.generatedFiles).toHaveLength(1);
  expect(result.generatedFiles[0]!.content).toBe(resolved.assets[0]!.text);
  expect(result.taskset.graders[0]!.kind).toBe("custom_verifier");
  expect(() => prepareModelStarterTaskset({ ...input, source: { ...source, profileId: "other" } })).toThrow("belong to this Profile");
  expect(() => prepareModelStarterTaskset({ ...input, approvedTrainingTaskIds: [resolved.taskset.tasks.find(task => task.split === "frozen_eval")!.id] })).toThrow("training task");
  expect(() => prepareModelStarterTaskset({ ...input, approvedTrainingTaskIds: [] })).toThrow("approved demonstrations");
  expect(() => prepareModelStarterTaskset({ ...input, source: { ...source, secretScanStatus: "pending" } })).toThrow("secret scanning");
});

// Importing a rubric is authoring, not a human approval or training run. Its
// exact private source and evaluation-only role must survive model creation.
it("creates a starter with a required human review without fabricating review evidence", async () => withTempDirectory("human-starter-", async home => {
  const input = await starterInput();
  const rubric = createLearningTextAsset({ text: "Check meaning and prose clarity against the supplied source. Reject unsupported claims.", path: "review.md", mediaType: "text/markdown", visibility: "verifier" });
  const human = RewardReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardRelease.v1", id: "editorial-review", revision: 1, name: "Editorial review", description: "Human assessment", implementation: { kind: "human", rubricRef: rubric.asset, reviewerRole: "editor" }, rawScore: { minimum: 0, maximum: 1 }, assets: [rubric.asset] }));
  const { contentHash: _bindingHash, ...bindingContent } = input.package.rewardBinding;
  const binding = RewardBindingSchema.parse(sealLearningContent({ ...bindingContent, sources: [...bindingContent.sources, { graderId: "editorial", reward: learningRef(human), role: "evaluation", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }] }));
  const { contentHash: _definitionHash, ...definitionContent } = input.package.taskDefinition;
  const execution = { ...definitionContent.execution, policy: { ...definitionContent.execution.policy, hiddenGraderRefs: [...definitionContent.execution.policy.hiddenGraderRefs, "editorial"] } };
  const definition = TaskDefinitionSchema.parse(sealLearningContent({ ...definitionContent, execution, rewardBinding: learningRef(binding) }));
  const rewards = [...input.package.rewards, human], assets = [...input.package.assets, rubric];
  const { contentHash: _tasksetHash, ...tasksetContent } = input.package.taskset;
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ ...tasksetContent, ...execution, graders: compileBoundGraders(binding, rewards) }));
  const { contentHash: _starterHash, ...starterContent } = input.package.starter;
  const starter = ModelStarterSchema.parse(sealLearningContent({ ...starterContent, taskDefinition: learningRef(definition), taskset: learningRef(taskset), rewardBinding: learningRef(binding), rewards: rewards.map(learningRef), assets: assets.map(learningRef) }));
  const resolved = validateResolvedModelStarter({ starter, taskset, taskDefinition: definition, rewardBinding: binding, rewards, assets });
  const configured = { ...input, package: resolved, request: { ...input.request, starter: learningRef(starter) }, source: { ...input.source, sourceHash: starter.contentHash } };
  const store = new SqliteStore(home);
  try {
    const saved = await store.saveModelStarterCreation(configured);
    const reopened = await store.getTaskset(saved.trainingSetup.tasksetRef!.id);
    expect(reopened?.capabilities.rewardKinds).toEqual(["deterministic", "human"]);
    expect(reopened?.graders.find(grader => grader.kind === "human")).toMatchObject({ rubric: rubric.text, rewardEligible: false, reviewerRole: "editor" });
    expect(reopened?.readiness).toBeNull();
    expect(reopened?.status).toBe("needs_review");
    expect(await store.findModelStarterCreation(configured.request)).toEqual(saved);
  } finally { await store.close(); }
}));

// A GRPO import must execute the pinned Reward and keep held-out tasks out of
// training signals without treating authored fixtures as execution receipts.
it("prepares verifier-based GRPO from approved training tasks and preserves private evaluation splits", async () => {
  const input = await starterInput();
  const { contentHash: _oldHash, ...content } = input.package.starter;
  const starter = ModelStarterSchema.parse(sealLearningContent({ ...content, revision: content.revision + 1, supportedMethods: ["grpo"], defaultMethod: "grpo" }));
  const request = await createModelStarterCreationRequest({ profileId: input.request.profileId, modelId: input.request.modelId, name: input.request.name, starter: learningRef(starter), startingModel: starter.startingModel, method: "grpo" });
  const configured = { ...input, request, package: { ...input.package, starter }, source: { ...input.source, sourceHash: starter.contentHash } };
  expect(() => prepareModelStarterTaskset(configured)).toThrow("every training task");
  const approvedTrainingTaskIds = input.package.taskset.tasks.filter(task => task.split === "train").map(task => task.id);
  const prepared = prepareModelStarterTaskset({ ...configured, approvedTrainingTaskIds });
  expect(prepared.taskset.capabilities.compatibleMethods).toEqual(["grpo"]);
  expect(prepared.taskset.learningSignals.rewards.map(reward => reward.taskId)).toEqual(approvedTrainingTaskIds);
  expect(prepared.taskset.learningSignals.rewards.every(reward => reward.executable)).toBe(true);
  expect(prepared.taskset.graders[0]!.kind).toBe("custom_verifier");
  expect(prepared.generatedFiles[0]!.content).toBe(input.package.assets[0]!.text);
  expect(prepared.taskset.tasks.filter(task => task.split === "frozen_eval")).toHaveLength(20);
  expect(prepared.taskset.readiness).toBeNull();
});

async function starterInput() {
  const resolved = validateResolvedModelStarter(structuredClone(starterImportFixture));
  const request = await createModelStarterCreationRequest({ profileId: "profile", modelId: "model", name: "Invoices", starter: learningRef(resolved.starter), startingModel: resolved.starter.startingModel, method: "sft" });
  const createdAt = "2026-09-06T20:00:00.000Z";
  const source = TasksetSourceRefSchema.parse({ schemaVersion: "openpond.generatedDatasetSource.v1", kind: "generated", id: "source", profileId: "profile", title: "Original test invoices", sourceHash: resolved.starter.contentHash, occurredAt: createdAt, licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", generatorId: "invoice-fixture", generatorVersion: "1", generatorHash: resolved.taskset.contentHash, seed: 0, metadata: {} });
  const task = resolved.taskset.tasks[0]!;
  const input = { request, package: resolved, source, createdAt, approvedTrainingTaskIds: [task.id], fixtures: [{ id: "positive", taskId: task.id, label: "positive" as const, output: task.expectedOutput!, infrastructureError: null, expectedPassed: true, expectedRewardEligible: true, metadata: {} }] };
  return input;
}

// Real SQLite connections exercise concurrency and rollback after dependencies
// have already been inserted, including retries after a later model edit.
it("commits one starter across concurrent saves and retains the original retry result after restart", async () => withTempDirectory("starter-commit-", async home => {
  const first = new SqliteStore(home);
  await first.listModelProjects();
  const second = new SqliteStore(home);
  try {
    await second.listModelProjects();
    const input = await starterInput();
    const [saved, duplicate] = await Promise.all([first.saveModelStarterCreation(input), second.saveModelStarterCreation(input)]);
    expect(duplicate).toEqual(saved);
    expect(await first.listModelProjects()).toHaveLength(1);
    expect(saved.trainingSetup.rewardBindingRef).toEqual(learningRef(input.package.rewardBinding));
    expect(await first.getTaskset(saved.trainingSetup.tasksetRef!.id)).not.toBeNull();
    await first.saveModelProject({ ...saved, name: "Edited later", revision: saved.revision + 1 });
    await expect(second.saveModelStarterCreation({ ...input, request: { ...input.request, name: "Conflicting intent" } })).rejects.toThrow("different configuration");
    await first.close();
    const reopened = new SqliteStore(home);
    try { expect(await reopened.findModelStarterCreation(input.request)).toEqual(saved); expect(await reopened.saveModelStarterCreation({ ...input, createdAt: "2026-09-07T00:00:00.000Z" })).toEqual(saved); }
    finally { await reopened.close(); }
  } finally { await first.close(); await second.close(); }
}));

// The starter picker must persist the user's exact selection and reject an
// unavailable replacement atomically instead of silently using the default.
it("persists starter Reward selection and rejects missing replacement bindings", async () => withTempDirectory("starter-reward-choice-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const { contentHash: _hash, ...content } = input.package.rewardBinding;
    const replacement = RewardBindingSchema.parse(sealLearningContent({ ...content, id: "chosen-binding", name: "My chosen checks" }));
    await store.learningRepository().transaction(input.request.profileId, async tx => {
      await tx.put("reward", input.package.rewards[0]!, 0);
      await tx.put("binding", replacement, 0);
    });
    const chosen = { ...input, request: { ...input.request, rewardBindingRef: learningRef(replacement) } };
    const saved = await store.saveModelStarterCreation(chosen);
    expect(saved.trainingSetup.rewardBindingRef).toEqual(learningRef(replacement));
    expect((await store.getModelProject(saved.id))?.trainingSetup.rewardBindingRef).toEqual(learningRef(replacement));
    await expect(store.saveModelStarterCreation({ ...chosen, request: { ...chosen.request, rewardBindingRef: null } })).rejects.toThrow("different configuration");
    const missing = { ...input, request: { ...input.request, modelId: "missing-reward-model", operationId: "missing-reward-operation", rewardBindingRef: { ...learningRef(replacement), id: "missing-binding" } } };
    await expect(store.saveModelStarterCreation(missing)).rejects.toThrow("unavailable");
    expect(await store.getModelProject(missing.request.modelId)).toBeNull();
    expect(await store.findModelStarterCreation(missing.request)).toBeNull();
  } finally { await store.close(); }
}));

it("rolls back imported resources when a later immutable dependency conflicts", async () => withTempDirectory("starter-rollback-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const { contentHash: _hash, ...definition } = input.package.taskDefinition;
    const conflict = TaskDefinitionSchema.parse(sealLearningContent({ ...definition, description: "An existing different definition" }));
    await store.learningRepository().transaction(input.request.profileId, async tx => { await tx.put("definition", conflict, 0); });
    const check = await createModelStarterCreationService({ store, home, catalog: { resolve: async () => input } }).check(input.request, input.request.profileId, []);
    expect(check.canSave).toBe(false);
    expect(check.findings).toContainEqual(expect.objectContaining({ code: "starter_dependency_conflict" }));
    await expect(store.saveModelStarterCreation(input)).rejects.toThrow("dependency conflicts");
    expect(await store.getModelProject(input.request.modelId)).toBeNull();
    expect(await store.getTaskset(prepareModelStarterTaskset(input).taskset.id)).toBeNull();
    expect(await store.findModelStarterCreation(input.request)).toBeNull();
    await store.learningRepository().transaction(input.request.profileId, async tx => {
      expect(await tx.get("asset", input.package.assets[0]!.id)).toBeNull();
      expect(await tx.get("reward", input.package.rewards[0]!.id)).toBeNull();
      expect(await tx.get("binding", input.package.rewardBinding.id)).toBeNull();
      expect(await tx.get("definition", conflict.id)).toEqual(conflict);
    });
  } finally { await store.close(); }
}));

// A visible model must never reference a package whose verifier files failed to
// materialize; preview and unauthorized requests cannot create a model.
it("materializes exact files before creation and retries without reopening the catalog", async () => withTempDirectory("starter-service-", async home => {
  const store = new SqliteStore(home);
  try {
    const fixture = await starterInput();
    let resolutions = 0;
    let available = true;
    const service = createModelStarterCreationService({ store, home, now: () => fixture.createdAt, catalog: { resolve: async () => {
      resolutions++;
      if (!available) throw new Error("Catalog unavailable");
      return fixture;
    } } });
    const preview = await service.preview(fixture.request.starter, "profile");
    expect(preview.tasks).toHaveLength(3);
    expect(await store.listModelProjects()).toHaveLength(0);
    await expect(service.create(fixture.request, "foreign")).rejects.toThrow("authorized Profile");
    expect(resolutions).toBe(1);
    await mkdir(path.join(home, "training"), { recursive: true });
    await writeFile(path.join(home, "training", "tasksets"), "block package directory");
    await expect(service.create(fixture.request, "profile")).rejects.toThrow();
    expect(await store.findModelStarterCreation(fixture.request)).toBeNull();
    expect(await store.listModelProjects()).toHaveLength(0);
    await rm(path.join(home, "training", "tasksets"));
    const saved = await service.create(fixture.request, "profile");
    const prepared = prepareModelStarterTaskset(fixture);
    const root = path.join(home, "training", "tasksets", saved.trainingSetup.tasksetRef!.id);
    expect(await readFile(path.join(root, prepared.generatedFiles[0]!.path), "utf8")).toBe(fixture.package.assets[0]!.text);
    expect(JSON.parse(await readFile(path.join(root, "taskset.json"), "utf8")).contentHash).toBe(saved.trainingSetup.tasksetRef!.contentHash);
    available = false;
    const beforeRetry = resolutions;
    expect(await service.create(fixture.request, "profile")).toEqual(saved);
    expect(resolutions).toBe(beforeRetry);
  } finally { await store.close(); }
}));

// The installed runtime must resolve the public catalog payload and use its
// hashed authoring data, rather than accepting caller-supplied approval fields.
it("creates through the runtime using only the hosted package's authored targets", async () => withTempDirectory("starter-runtime-", async home => {
  const store = new SqliteStore(home);
  const fixture = await starterInput();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    expect(String(url)).toContain("/v1/model-starter-catalog/releases/");
    return Response.json(fixture.package);
  });
  try {
    const runtime = createModelStarterRuntime({ store, home, resolveAccess: async () => ({ apiBaseUrl: "https://catalog.invalid", token: "test", teamId: "team" }) });
    expect((await runtime.preview(fixture.request.starter)).tasks).toHaveLength(3);
    await expect(runtime.create({ ...fixture.request, approvedTrainingTaskIds: ["forged"] })).rejects.toThrow();
    const saved = await runtime.create(fixture.request);
    const taskset = await store.getTaskset(saved.trainingSetup.tasksetRef!.id);
    expect(taskset!.learningSignals.demonstrations).toHaveLength(40);
    expect(taskset!.learningSignals.demonstrations.every(signal => taskset!.tasks.find(task => task.id === signal.taskId)?.split === "train")).toBe(true);
    expect(taskset!.graderFixtures).toHaveLength(80);
  } finally { fetchMock.mockRestore(); await store.close(); }
}));

// Synthetic contact data needs an exact publisher review; neither arbitrary
// caller approval nor a publisher privacy review can override a secret finding.
it("requires bound publisher privacy review and preserves secret blocking", async () => withTempDirectory("starter-privacy-", async home => {
  const store = new SqliteStore(home);
  const value = (await starterInput()).package;
  value.taskset.metadata.testContact = "synthetic@example.test";
  const reseal = () => {
    const { contentHash: _taskHash, ...taskset } = value.taskset;
    value.taskset.contentHash = sealLearningContent(taskset).contentHash;
    value.starter.taskset = learningRef(value.taskset);
    const { contentHash: _starterHash, ...starter } = value.starter;
    value.starter.contentHash = sealLearningContent(starter).contentHash;
  };
  const request = (modelId: string) => createModelStarterCreationRequest({ profileId: "profile", modelId, name: "Reviewed fixture", starter: learningRef(value.starter), startingModel: value.starter.startingModel, method: "sft" });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(value));
  try {
    const runtime = createModelStarterRuntime({ store, home, resolveAccess: async () => ({ apiBaseUrl: "https://catalog.invalid", token: "test", teamId: "team" }) });
    reseal();
    await expect(runtime.create(await request("unreviewed"))).rejects.toThrow("unresolved PII policy");
    const authoring = value.taskset.metadata.starterAuthoring as Record<string, unknown>;
    authoring.privacyReview = { schemaVersion: "openpond.modelStarterPrivacyReview.v1", disposition: "synthetic_only", reviewedBy: "Fixture publisher", reviewedAt: "2026-09-07T06:00:00.000Z", reviewedContentHash: modelStarterPrivacyContentHash(value), note: "Original synthetic contact data." };
    reseal();
    const saved = await runtime.create(await request("reviewed"));
    const taskset = (await store.getTaskset(saved.trainingSetup.tasksetRef!.id))!;
    expect(taskset.sourceRefs[0]!.piiScanStatus).toBe("passed");
    expect(taskset.sourceRefs[0]!.metadata.privacyReview).toEqual(authoring.privacyReview);
    value.taskset.metadata.testCredential = "password=synthetic-secret-fixture";
    (authoring.privacyReview as { reviewedContentHash: string }).reviewedContentHash = modelStarterPrivacyContentHash(value);
    reseal();
    await expect(runtime.create(await request("secret-blocked"))).rejects.toThrow("secret");
  } finally { fetchMock.mockRestore(); await store.close(); }
}));
