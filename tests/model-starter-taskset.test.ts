import { expect, it, vi } from "vitest";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TasksetSourceRefSchema, TrainingDestinationCapabilitiesSchema } from "@openpond/contracts";
import { createLearningTextAsset, learningRef, sealLearningContent, TaskDefinitionSchema } from "@openpond/evals/learning";
import { ModelStarterSchema, createModelStarterCreationRequest, modelStarterPrivacyContentHash, validateResolvedModelStarter, modelTasksetExecutionResourcesAssetId, resolveModelTasksetExecutionResourcesAsset } from "openpond-sdk/model-starters";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { withTempDirectory } from "./helpers/temp-directory.js";
import starterImportFixture from "./fixtures/model-starter-import.json";
import { prepareModelStarterTaskset } from "../apps/server/src/training/model-starter-taskset.js";
import { createModelStarterCreationService } from "../apps/server/src/training/model-starter-creation-service.js";
import { createModelStarterRuntime } from "../apps/server/src/training/model-starter-runtime.js";
import { exportLocalModelTasksetPackage } from "../apps/server/src/training/model-taskset-package-export.js";
import { createTasksetPackage, decodeTasksetPackageFile, TasksetPackagePublicationSchema, type TasksetPackageReceipt } from "openpond-sdk/taskset-packages";
import { createModelProjectHostingService } from "../apps/server/src/training/model-project-hosting.js";
import { tasksetPackageDirectoryId } from "../apps/server/src/training/taskset-package-path.js";
import { hostedModelProjectTrainingSetup } from "../apps/server/src/training/model-project-hosted-projection.js";
import { validateTaskset } from "@openpond/taskset-sdk";
import { projectBaseModelCandidates } from "../apps/server/src/training/base-model-candidates.js";
import { openStorageDatabase } from "@openpond/persistence";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service.js";
import { attemptFixture, sftRecipeFixture } from "./helpers/training-fixtures.js";
import { materializePortableTasksetRelease, computeTasksetHash, hashTasksetDraftPackage, publishTasksetDraft, tasksetDraftFromTaskset, sha256 } from "@openpond/taskset-sdk";
import { buildTasksetTrainingBundle } from "@openpond/training-sdk";
import { resolveTasksetTrainingReward, resolveManagedTasksetReward } from "../apps/server/src/training/taskset-reward-binding.js";
import { requireReleasedTaskset } from "../apps/server/src/training/local-taskset-release.js";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema, type TasksetRelease } from "@openpond/evals/tasksets";
import { compileDesktopHarnessContext } from "../apps/server/src/training/portable-evals-adapter.js";
import { createModelProjectSaveRequest, ModelProjectSchema, HostedModelProjectSummarySchema, type HostedModelProjectSummary, type ModelProject } from "openpond-sdk/model-projects";
import { readTasksetGraderDetails } from "../apps/server/src/training/taskset-grader-details.js";
import { materializeImmutableTasksetPackage } from "../apps/server/src/training/model-starter-package-files.js";

// A lost successful response followed by offline edits must replay the durable
// original operation first, then publish the newer configuration without loss.
it("recovers atomic package pushes after restart and attaches history without retargeting", async () => withTempDirectory("package-push-", async home => {
  let store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const original = await store.saveModelStarterCreation(input);
    const receipts = new Map<string, TasksetPackageReceipt>();
    let remote: HostedModelProjectSummary | null = null;
    let loseResponse = true;
    let rejectNext = false;
    const calls: string[] = [];
    const service = (teamId = "team") => createModelProjectHostingService({ store,
      resolveAccess: async () => ({ apiBaseUrl: "https://staging-api.openpond.ai", token: "test-key", teamId }),
      fetch: async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/v1/taskset-packages");
        expect(init?.method).toBe("POST");
        const request = TasksetPackagePublicationSchema.parse(JSON.parse(String(init?.body)));
        calls.push(request.operationId);
        if (receipts.has(request.operationId)) return Response.json(receipts.get(request.operationId));
        if (rejectNext) { rejectNext = false; return Response.json({ code: "publication_rejected", message: "Fixture rejects this attempt before commit" }, { status: 422 }); }
        expect(request.expectedProjectEtag).toBe(remote?.etag ?? null);
        expect(request.package.files.length).toBeGreaterThan(0);
        if (request.selection === "select") {
          const configuration = request.modelConfiguration!;
          remote = HostedModelProjectSummarySchema.parse({ ...configuration, id: "remote-model", teamId: "team",
            revision: (remote?.revision ?? 0) + 1, etag: sha256(request.operationId), createdAt: original.createdAt, updatedAt: configuration.sourceUpdatedAt,
            trainingSetup: { ...configuration.trainingSetup, tasksetRef: learningRef(request.package.taskset),
              rewardBindingRef: learningRef(request.package.modelResources!.rewardBinding), tasksetRelease: null, recipe: null } });
        } else expect(request.modelConfiguration).toBeUndefined();
        const receipt: TasksetPackageReceipt = { schemaVersion: "openpond.tasksetPackageReceipt.v1", teamId: "team",
          modelProjectId: request.modelProjectId, operationId: request.operationId, selection: request.selection,
          taskset: learningRef(request.package.taskset), packageHash: request.package.contentHash,
          hostedTasksetId: `hosted-${request.package.taskset.id}`, projectEtag: remote!.etag,
          ...(request.selection === "select" ? { project: remote! } : {}) };
        receipts.set(request.operationId, receipt);
        if (loseResponse) { loseResponse = false; throw new TypeError("Response lost after commit"); }
        return Response.json(receipt);
      },
    });
    await expect(service().syncProject(original.id)).rejects.toThrow("Response lost");
    expect((await store.getModelProject(original.id))!.hosted).toBeNull();
    await expect(service("other-workspace").syncProject(original.id)).rejects.toThrow("original API and workspace");
    expect(calls).toHaveLength(1);
    const edited = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: original.id, profileId: original.profileId,
      name: "Edited while offline", objective: original.objective, defaultBaseModel: original.defaultBaseModel,
      defaultDestinationId: original.defaultDestinationId, trainingSetup: original.trainingSetup }, original.revision));
    await store.close();
    store = new SqliteStore(home);
    const pushed = await service().syncProject(original.id);
    expect(pushed.name).toBe(edited.name);
    expect(pushed.revision).toBe(edited.revision);
    expect(pushed.hosted!.syncedSourceRevision).toBe(edited.revision);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(calls[1]);
    expect(receipts.size).toBe(2);
    expect(remote!.name).toBe(edited.name);
    const third = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: pushed.id, profileId: pushed.profileId,
      name: "Third configuration", objective: pushed.objective, defaultBaseModel: pushed.defaultBaseModel,
      defaultDestinationId: pushed.defaultDestinationId, trainingSetup: pushed.trainingSetup }, pushed.revision));
    const selectedTaskset = (await store.getTaskset(third.trainingSetup.tasksetRef!.id))!;
    const selectedPackage = await exportLocalModelTasksetPackage({ store, storeDir: home, profileId: third.profileId, modelId: third.id });
    rejectNext = true;
    await expect(service().publishTaskset({ projectId: third.id, taskset: selectedTaskset, release: selectedPackage.taskset })).rejects.toThrow("Fixture rejects");
    expect(await store.pendingModelPackagePush({ profileId: third.profileId, modelId: third.id, apiOrigin: "https://staging-api.openpond.ai", teamId: "team" })).toBeNull();
    await service().publishTaskset({ projectId: third.id, taskset: selectedTaskset, release: selectedPackage.taskset });
    expect(calls[calls.length - 2]).toBe(calls[calls.length - 1]);
    expect(remote!.name).toBe(third.name);
    const otherRequest = await createModelStarterCreationRequest({ profileId: input.request.profileId, modelId: "other-model", name: "Other tasks",
      starter: input.request.starter, startingModel: input.request.startingModel, method: "sft" });
    const other = await store.saveModelStarterCreation({ ...input, request: otherRequest });
    const otherTaskset = (await store.getTaskset(other.trainingSetup.tasksetRef!.id))!;
    const otherPackage = await exportLocalModelTasksetPackage({ store, storeDir: home, profileId: other.profileId, modelId: other.id });
    const selectedBefore = pushed.trainingSetup.tasksetRef;
    const etagBefore = remote!.etag;
    const attached = await service().publishTaskset({ projectId: original.id, taskset: otherTaskset, release: otherPackage.taskset });
    expect(attached.trainingSetup.tasksetRef).toEqual(selectedBefore);
    expect(remote!.etag).toBe(etagBefore);
    expect(attached.hosted!.tasksets).toHaveLength(2);
    expect(receipts.size).toBe(4);
    expect(await store.pendingModelPackagePush({ profileId: original.profileId, modelId: original.id, apiOrigin: "https://staging-api.openpond.ai", teamId: "team" })).toBeNull();
  } finally { await store.close(); }
}));

// A metadata-only pull loses private inputs. Exercise the real SQLite/file
// boundary and show that corrupt bytes or a concurrent edit cannot replace it.
it("pulls complete private packages atomically and exports their exact bytes after reopen", async () => withTempDirectory("package-pull-", async home => {
  const source = new SqliteStore(path.join(home, "source"));
  let target = new SqliteStore(path.join(home, "target"));
  try {
    const input = await starterInput();
    const original = await source.saveModelStarterCreation(input);
    const exported = await exportLocalModelTasksetPackage({ store: source, storeDir: source.home, profileId: original.profileId, modelId: original.id });
    const bytes = Buffer.from([255, 0, 128, 11, 10]);
    const asset = { id: "private-extra", path: "private/extra.bin", mediaType: "application/octet-stream", visibility: "host_private" as const, sizeBytes: bytes.length, contentHash: sha256(bytes) };
    const { contentHash: _hash, ...content } = exported;
    const value = createTasksetPackage({ ...content, files: [{ asset, base64: bytes.toString("base64") }, ...exported.files] });
    const hosted = { id: "remote-model", teamId: "team", portableProjectId: original.id, name: original.name,
      objective: original.objective, defaultBaseModel: original.defaultBaseModel, defaultDestinationId: original.defaultDestinationId,
      trainingSetup: { ...hostedModelProjectTrainingSetup(original.trainingSetup), tasksetRef: learningRef(value.taskset) }, sourceRevision: 1, revision: 1,
      etag: "a".repeat(64), sourceUpdatedAt: original.updatedAt, createdAt: original.createdAt, updatedAt: original.updatedAt };
    let corrupt = true;
    let servedPackage = value;
    let duringDownload: (() => Promise<void>) | null = null;
    const service = (store = target) => createModelProjectHostingService({ store,
      resolveAccess: async () => ({ apiBaseUrl: "https://staging-api.openpond.ai", token: "test-key", teamId: "team" }),
      fetch: async url => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.startsWith("/v1/taskset-packages/")) {
          await duringDownload?.();
          return Response.json({ schemaVersion: "openpond.tasksetPackageReadback.v1", teamId: "team", modelProjectId: hosted.id,
            package: corrupt ? { ...servedPackage, files: [] } : servedPackage });
        }
        if (pathname.startsWith("/v1/taskset-catalog/")) return Response.json({ schemaVersion: "openpond.hostedTasksetSummary.v1",
          id: "remote-taskset", teamId: "team", release: learningRef(servedPackage.taskset), name: "Imported invoices", description: "Private test package",
          taskCount: value.taskset.tasks.length, buildIntent: "verifiable_reward", methodHint: "sft", packageBytes: null, storedBytes: null, createdAt: original.createdAt });
        if (pathname === "/v1/managed-rl/jobs") return Response.json({ jobs: [] });
        return Response.json({ project: { ...hosted, trainingSetup: { ...hosted.trainingSetup, tasksetRef: learningRef(servedPackage.taskset),
          rewardBindingRef: servedPackage.modelResources ? learningRef(servedPackage.modelResources.rewardBinding) : null } }, resources: [], jobCount: 0, latestJobIds: [] });
      },
    });
    const pull = () => service().pullProject({ hostedProjectId: hosted.id, profileId: "import-profile" });
    await expect(pull()).rejects.toThrow();
    expect(await target.getModelProject(original.id)).toBeNull();
    expect(await target.getTaskset(value.taskset.id)).toBeNull();
    corrupt = false;
    const pulled = (await pull()).project;
    const local = (await target.getTaskset(value.taskset.id))!;
    expect(pulled.trainingSetup.tasksetRef).toEqual(learningRef(local));
    expect(local.contentHash).not.toBe(value.taskset.contentHash);
    expect(local.sourceRefs[0]).toMatchObject({ licensingStatus: "pending", secretScanStatus: "pending", piiScanStatus: "pending" });
    expect(validateTaskset(local).valid).toBe(false);
    expect(await readFile(path.join(target.home, "training", "tasksets", tasksetPackageDirectoryId(local), asset.path))).toEqual(bytes);
    await target.close();
    target = new SqliteStore(path.join(home, "target"));
    expect(await exportLocalModelTasksetPackage({ store: target, storeDir: target.home, profileId: pulled.profileId, modelId: pulled.id })).toEqual(value);
    expect((await pull()).project.trainingSetup.tasksetRef).toEqual(learningRef(local));
    duringDownload = async () => {
      const current = (await target.getModelProject(pulled.id))!;
      await target.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: current.id, profileId: current.profileId,
        name: "Local concurrent edit", objective: current.objective, defaultBaseModel: current.defaultBaseModel,
        defaultDestinationId: current.defaultDestinationId, trainingSetup: current.trainingSetup }, current.revision));
    };
    await expect(pull()).rejects.toThrow("Model changed");
    expect((await target.getModelProject(pulled.id))!.name).toBe("Local concurrent edit");
    for (const weight of [2, 3]) {
      const current = (await target.getModelProject(pulled.id))!;
      const { contentHash: _bindingHash, ...bindingContent } = value.modelResources!.rewardBinding;
      const binding = RewardBindingSchema.parse(sealLearningContent({ ...bindingContent, id: `imported-binding-${weight}`, sources: bindingContent.sources.map(item => ({ ...item, weight })) }));
      await target.learningRepository().transaction(current.profileId, async tx => { await tx.put("binding", binding, 0); });
      const request = await createModelProjectSaveRequest({ id: current.id, profileId: current.profileId, name: current.name,
        objective: current.objective, defaultBaseModel: current.defaultBaseModel, defaultDestinationId: current.defaultDestinationId,
        trainingSetup: { ...current.trainingSetup, rewardBindingRef: learningRef(binding) } }, current.revision);
      const edited = await target.saveModelProjectConfiguration(request);
      expect(edited.trainingSetup.tasksetRef!.id).toBe(local.id);
      expect(edited.trainingSetup.tasksetRef!.revision).toBe(local.revision + weight - 1);
      expect(await target.saveModelProjectConfiguration(request)).toEqual(edited);
      const updated = await exportLocalModelTasksetPackage({ store: target, storeDir: target.home, profileId: current.profileId, modelId: current.id });
      expect(updated.files.find(file => file.asset.id === asset.id)).toEqual(value.files[0]);
      expect(updated.modelResources!.rewardBinding).toEqual(binding);
      expect((await target.getTasksetRevision(local.id, local.revision))!.contentHash).toBe(local.contentHash);
    }
    // Recover an older link without changing its already authored immutable
    // local Taskset or inferring the API origin from a matching team ID alone.
    duringDownload = null;
    servedPackage = exported;
    const originalTaskset = await source.getTaskset(value.taskset.id);
    await source.saveModelProjectHosting(original, ModelProjectSchema.parse({ ...original, hosted: {
      schemaVersion: "openpond.hostedModelProjectLink.v1", apiOrigin: null, teamId: hosted.teamId,
      projectId: hosted.id, portableProjectId: original.id, revision: hosted.revision, etag: hosted.etag,
      syncedSourceRevision: original.revision, syncedAt: original.updatedAt, tasksets: [],
    } }));
    const recovered = await service(source).pullProject({ hostedProjectId: hosted.id, profileId: original.profileId });
    expect(recovered.project.hosted!.apiOrigin).toBe("https://staging-api.openpond.ai");
    expect(await source.getTaskset(value.taskset.id)).toEqual(originalTaskset);
    expect(await exportLocalModelTasksetPackage({ store: source, storeDir: source.home, profileId: original.profileId, modelId: original.id })).toEqual(exported);
    const generic = new SqliteStore(path.join(home, "generic"));
    try {
      const { contentHash: _genericHash, modelResources: _genericResources, ...unboundContent } = exported;
      const { contentHash: _boundHash, ...unboundRelease } = exported.taskset;
      servedPackage = createTasksetPackage({ ...unboundContent, taskset: TasksetReleaseSchema.parse(sealLearningContent({ ...unboundRelease, metadata: {} })) });
      const ordinary = await service(generic).pullProject({ hostedProjectId: hosted.id, profileId: "ordinary-profile" });
      expect(ordinary.project.trainingSetup.rewardBindingRef).toBeNull();
      const ordinaryTaskset = (await generic.getTaskset(ordinary.project.trainingSetup.tasksetRef!.id))!;
      expect(ordinaryTaskset.objective).toBe("");
      expect(ordinaryTaskset.metadata.taskDefinition).toBeUndefined();
      expect(ordinaryTaskset.graders[0]!.kind).toBe(exported.taskset.graders[0]!.kind);
      expect(await exportLocalModelTasksetPackage({ store: generic, storeDir: generic.home, profileId: ordinary.project.profileId, modelId: ordinary.project.id })).toEqual(servedPackage);
    } finally { await generic.close(); }
  } finally { await source.close(); await target.close(); }
}));

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
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ ...tasksetContent, ...execution, graders: compileBoundGraders(binding, rewards), metadata: { ...tasksetContent.metadata, starter: { taskDefinition: learningRef(definition), rewardBinding: learningRef(binding) } } }));
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

async function starterInput(metrics?: TasksetRelease["metrics"]) {
  const original = validateResolvedModelStarter(structuredClone(starterImportFixture));
  const { contentHash: _tasksetHash, ...tasksetContent } = original.taskset;
  const { contentHash: _starterHash, ...starterContent } = original.starter;
  const taskset = metrics ? TasksetReleaseSchema.parse(sealLearningContent({ ...tasksetContent, metrics })) : original.taskset;
  const resolved = metrics ? validateResolvedModelStarter({ ...original, taskset,
    starter: ModelStarterSchema.parse(sealLearningContent({ ...starterContent, taskset: learningRef(taskset) })),
  }) : original;
  const request = await createModelStarterCreationRequest({ profileId: "profile", modelId: "model", name: "Invoices", starter: learningRef(resolved.starter), startingModel: resolved.starter.startingModel, method: "sft" });
  const createdAt = "2026-09-06T20:00:00.000Z";
  const source = TasksetSourceRefSchema.parse({ schemaVersion: "openpond.generatedDatasetSource.v1", kind: "generated", id: "source", profileId: "profile", title: "Original test invoices", sourceHash: resolved.starter.contentHash, occurredAt: createdAt, licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", generatorId: "invoice-fixture", generatorVersion: "1", generatorHash: resolved.taskset.contentHash, seed: 0, metadata: {} });
  const task = resolved.taskset.tasks[0]!;
  const input = { request, package: resolved, source, createdAt, approvedTrainingTaskIds: [task.id], fixtures: [{ id: "positive", taskId: task.id, label: "positive" as const, output: task.expectedOutput!, infrastructureError: null, expectedPassed: true, expectedRewardEligible: true, metadata: {} }] };
  return input;
}

// First-time users may choose a later catalog release. Missing predecessors
// must not block creation, and an older import must not roll back local edits.
it("imports later published revisions first and preserves immutable history and edit conflicts", async () => withTempDirectory("starter-revision-import-", async home => {
  const store = new SqliteStore(home);
  try {
    const original = await starterInput();
    const revisionInput = async (revision: number, modelId: string, description = original.package.taskDefinition.description) => {
      const { contentHash: _definitionHash, ...definitionContent } = original.package.taskDefinition;
      const definition = TaskDefinitionSchema.parse(sealLearningContent({ ...definitionContent, revision, description }));
      const { contentHash: _tasksetHash, ...tasksetContent } = original.package.taskset;
      const taskset = TasksetReleaseSchema.parse(sealLearningContent({ ...tasksetContent, revision, metadata: { ...tasksetContent.metadata, starter: { taskDefinition: learningRef(definition), rewardBinding: learningRef(original.package.rewardBinding) } } }));
      const { contentHash: _starterHash, ...starterContent } = original.package.starter;
      const starter = ModelStarterSchema.parse(sealLearningContent({ ...starterContent, revision, taskDefinition: learningRef(definition), taskset: learningRef(taskset) }));
      const value = validateResolvedModelStarter({ ...original.package, starter, taskset, taskDefinition: definition });
      const request = await createModelStarterCreationRequest({ profileId: original.request.profileId, modelId, name: "Revision import", starter: learningRef(starter), startingModel: starter.startingModel, method: "sft" });
      return { ...original, request, package: value, source: { ...original.source, sourceHash: starter.contentHash } };
    };
    const latest = await revisionInput(3, "latest-first");
    const [model, retry] = await Promise.all([store.saveModelStarterCreation(latest), store.saveModelStarterCreation(latest)]);
    expect(retry).toEqual(model);
    const id = latest.package.taskDefinition.id;
    await store.learningRepository().transaction(original.request.profileId, async tx => {
      expect(await tx.get("definition", id, 1)).toBeNull();
      expect(await tx.get("definition", id)).toEqual(latest.package.taskDefinition);
    });
    await store.saveModelStarterCreation(original);
    await store.saveModelStarterCreation(await revisionInput(2, "middle-later"));
    await store.learningRepository().transaction(original.request.profileId, async tx => {
      expect(await tx.get("definition", id, 1)).toEqual(original.package.taskDefinition);
      expect(await tx.get("definition", id)).toEqual(latest.package.taskDefinition);
      const { contentHash: _hash, ...content } = latest.package.taskDefinition;
      const edited = TaskDefinitionSchema.parse(sealLearningContent({ ...content, revision: 4, name: "My edited definition" }));
      await expect(tx.put("definition", edited, 2)).rejects.toThrow("Revision conflict");
      await tx.put("definition", edited, 3);
    });
    await store.saveModelStarterCreation(await revisionInput(3, "same-release-again"));
    expect((await store.learningRepository().transaction(original.request.profileId, tx => tx.get("definition", id)))?.revision).toBe(4);
    const conflict = await revisionInput(3, "conflicting-release", "Different content at the same revision");
    await expect(store.saveModelStarterCreation(conflict)).rejects.toThrow("dependency conflicts");
    expect(await store.getModelProject(conflict.request.modelId)).toBeNull();
  } finally { await store.close(); }
}));

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
    const taskset = (await store.getTasksetRevision(saved.trainingSetup.tasksetRef!.id, saved.trainingSetup.tasksetRef!.revision))!;
    expect(taskset.metadata.rewardBinding).toEqual(learningRef(replacement));
    expect(taskset.graders.every(grader => JSON.stringify(grader.metadata.rewardBinding) === JSON.stringify(learningRef(replacement)))).toBe(true);
    expect(materializePortableTasksetRelease({ taskset, adapterId: "starter-selection" }).tasksetRelease.metadata.rewardExecution).toEqual({ binding: replacement, rewards: input.package.rewards });
    await expect(store.saveModelStarterCreation({ ...chosen, request: { ...chosen.request, rewardBindingRef: null } })).rejects.toThrow("different configuration");
    const missing = { ...input, request: { ...input.request, modelId: "missing-reward-model", operationId: "missing-reward-operation", rewardBindingRef: { ...learningRef(replacement), id: "missing-binding" } } };
    await expect(store.saveModelStarterCreation(missing)).rejects.toThrow("unavailable");
    expect(await store.getModelProject(missing.request.modelId)).toBeNull();
    expect(await store.findModelStarterCreation(missing.request)).toBeNull();
  } finally { await store.close(); }
}));

// Two Models may share an immutable source. A Reward edit must publish and
// attach only the intended Model's revision, including retries after reopening.
it("atomically derives model-owned Tasksets while preserving shared sources and prior revisions", async () => withTempDirectory("model-taskset-derive-", async home => {
  let store = new SqliteStore(home);
  const otherStore = new SqliteStore(home);
  let retry: Awaited<ReturnType<typeof createModelProjectSaveRequest>>;
  let firstSaved: ModelProject;
  try {
    const metrics = { schemaVersion: "openpond.tasksetMetricPolicy.v1" as const, primaryMetric: "quality", aggregation: "pass_rate" as const, missingReward: "exclude" as const, customAggregator: null };
    const input = await starterInput(metrics);
    const model = await store.saveModelStarterCreation(input);
    // An installed v60 store has no preparation table; opening the new server
    // must migrate it without changing the existing model or source release.
    const storePath = store.storePath;
    await store.close();
    const previousVersion = openStorageDatabase(storePath);
    try { previousVersion.exec("DROP TABLE model_project_taskset_preparations; PRAGMA user_version = 60;"); }
    finally { previousVersion.close(); }
    store = new SqliteStore(home);
    expect(await store.getModelProject(model.id)).toEqual(model);
    const sourceRef = model.trainingSetup.tasksetRef!;
    const source = (await store.getTasksetRevision(sourceRef.id, sourceRef.revision))!;
    expect(source.metrics).toEqual(metrics);
    const editable = (value: ModelProject) => ({ id: value.id, profileId: value.profileId, name: value.name, objective: value.objective, defaultBaseModel: value.defaultBaseModel, defaultDestinationId: value.defaultDestinationId, trainingSetup: value.trainingSetup });
    const other = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...editable(model), id: "other-consumer" }, 0));
    const { contentHash: _oldHash, ...binding } = input.package.rewardBinding;
    const replacement = RewardBindingSchema.parse(sealLearningContent({ ...binding, revision: 2, sources: binding.sources.map(source => ({ ...source, weight: 2 })) }));
    await store.learningRepository().transaction(model.profileId, async tx => { await tx.put("binding", replacement, 1); });
    retry = await createModelProjectSaveRequest({ ...editable(model), trainingSetup: { ...model.trainingSetup, recipe: sftRecipeFixture(), rewardBindingRef: learningRef(replacement) } }, model.revision);
    // Fail after package materialization but before the Model/Taskset commit.
    // Reopening must reuse that preparation rather than publish twice.
    const database = openStorageDatabase(store.storePath);
    try {
      database.exec("CREATE TRIGGER interrupt_derived_save BEFORE UPDATE ON model_projects BEGIN SELECT RAISE(ABORT, 'Interrupted derived save'); END;");
      await expect(store.saveModelProjectConfiguration(retry)).rejects.toThrow("Interrupted derived save");
      expect(await store.getModelProject(model.id)).toEqual(model);
      expect(await store.listTasksets(model.profileId)).toHaveLength(1);
      database.exec("DROP TRIGGER interrupt_derived_save;");
    } finally { database.close(); }
    await store.close();
    store = new SqliteStore(home);
    firstSaved = await store.saveModelProjectConfiguration(retry);
    expect(firstSaved.trainingSetup.tasksetRef).toMatchObject({ id: source.id, revision: source.revision + 1 });
    expect(firstSaved.trainingSetup.recipe).toBeNull();
    expect(firstSaved.trainingSetup.tasksetRelease).toBeNull();
    const derived = (await store.getTasksetRevision(firstSaved.trainingSetup.tasksetRef!.id, firstSaved.trainingSetup.tasksetRef!.revision))!;
    expect(derived.readiness).toBeNull();
    expect(derived.metadata.rewardBinding).toEqual(learningRef(replacement));
    expect(derived.graders[0]!.weight).toBe(2);
    const portable = materializePortableTasksetRelease({ taskset: derived, adapterId: "derived-boundary" }).tasksetRelease;
    expect(derived.metrics).toEqual(metrics);
    expect(portable.metrics).toEqual(metrics);
    expect(await store.learningRepository().transaction(model.profileId, tx => tx.get("package", portable.id, portable.revision))).toEqual(portable);
    const resourcesAsset = await store.learningRepository().transaction(model.profileId, tx => tx.get("asset", modelTasksetExecutionResourcesAssetId(portable), 1));
    expect(resolveModelTasksetExecutionResourcesAsset(portable, resourcesAsset!)).toEqual(derived.environment.metadata.portableExecutionResources);
    expect(await store.getTasksetRevision(source.id, source.revision)).toEqual(source);
    expect((await store.getModelProject(other.id))!.trainingSetup.tasksetRef).toEqual(sourceRef);
    const firstPackage = path.join(home, "training", "tasksets", String(derived.environment.metadata.runtimeSourceTasksetId), "taskset.json");
    const firstBytes = await readFile(firstPackage, "utf8");
    expect(JSON.parse(firstBytes).contentHash).toBe(derived.contentHash);
    const details = await readTasksetGraderDetails({ store, storeDir: home, tasksetId: derived.id });
    expect(details.sources).toHaveLength(1);
    expect(details.sources[0]!.integrity).toBe("verified");
    const edit = await createModelProjectSaveRequest({ ...editable(firstSaved), trainingSetup: { ...firstSaved.trainingSetup, rewardBindingRef: learningRef(input.package.rewardBinding) } }, firstSaved.revision);
    const competing = await createModelProjectSaveRequest({ ...editable(firstSaved), name: "Concurrent rename" }, firstSaved.revision);
    const results = await Promise.allSettled([store.saveModelProjectConfiguration(edit), otherStore.saveModelProjectConfiguration(competing)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "model_revision_conflict" } });
    let latest = (await store.getModelProject(model.id))!;
    if (latest.trainingSetup.tasksetRef!.revision === derived.revision) latest = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...editable(latest), trainingSetup: { ...latest.trainingSetup, rewardBindingRef: learningRef(input.package.rewardBinding) } }, latest.revision));
    expect(latest.trainingSetup.tasksetRef).toMatchObject({ id: derived.id, revision: derived.revision + 1 });
    expect((await store.getTasksetRevision(derived.id, derived.revision + 1))!.metadata.rewardBinding).toEqual(learningRef(input.package.rewardBinding));
    expect(await readFile(firstPackage, "utf8")).toBe(firstBytes);
    expect(await store.getTasksetRevision(derived.id, derived.revision)).toEqual(derived);
    expect(await otherStore.saveModelProjectConfiguration(retry)).toEqual(firstSaved);
  } finally { await otherStore.close(); await store.close(); }
  const reopened = new SqliteStore(home);
  try { expect(await reopened.saveModelProjectConfiguration(retry!)).toEqual(firstSaved!); }
  finally { await reopened.close(); }
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

// A Reward edit must retain binary/input dependencies and output schemas. A
// corrupted input must fail publication before the visible Model changes.
it("preserves task files and schema references through a model-owned Reward edit", async () => withTempDirectory("derived-task-files-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    let model = await store.saveModelStarterCreation(input);
    const initialPackage = await exportLocalModelTasksetPackage({ store, storeDir: home, modelId: model.id, profileId: model.profileId });
    expect(initialPackage.modelResources?.rewardBinding).toEqual(input.package.rewardBinding);
    const source = (await store.getTasksetRevision(model.trainingSetup.tasksetRef!.id, 1))!;
    const sourceDirectory = path.join(home, "training", "tasksets", source.id);
    const sourceManifest = await readFile(path.join(sourceDirectory, "taskset.json"), "utf8");
    const text = "Invoice input retained through a Reward edit.\n";
    const asset = { id: "invoice-input", path: "assets/invoice.txt", contentHash: sha256(text), sizeBytes: Buffer.byteLength(text), mediaType: "text/plain", visibility: "policy" as const };
    const schema = createLearningTextAsset({ text: "{}", path: "assets/output-schema.json", mediaType: "application/json", visibility: "verifier" });
    const originalTask = materializePortableTasksetRelease({ taskset: source, adapterId: "asset-source" }).tasksetRelease.tasks[0]!;
    const output = { path: "answer.json", mediaType: "application/json", schemaRef: schema.asset, maxBytes: 10_000, metadata: {} };
    const draft = tasksetDraftFromTaskset(source);
    const withFiles = publishTasksetDraft({ now: input.createdAt, draft: { ...draft,
      environment: { ...draft.environment, metadata: { ...draft.environment.metadata, runtimeSourceTasksetId: "invoice-source-files" } },
      tasks: draft.tasks.map((task, index) => index === 0 ? { ...task,
        assets: [{ id: asset.id, sourceRefId: input.source.id, artifactRef: asset.path, fileName: "invoice.txt", mediaType: asset.mediaType, sha256: asset.contentHash, sizeBytes: asset.sizeBytes, split: task.split, metadata: {} }],
        requiredOutputs: [{ ...output, schemaRef: schema.id }],
        metadata: { ...task.metadata, portableTaskRecord: { ...originalTask, artifactRefs: [asset], requiredOutputs: [output] } },
      } : task),
    } });
    const sourceDraftDirectory = path.join(home, "source-draft");
    await cp(sourceDirectory, sourceDraftDirectory, { recursive: true });
    await mkdir(path.join(sourceDraftDirectory, "assets"), { recursive: true });
    await writeFile(path.join(sourceDraftDirectory, asset.path), text);
    await writeFile(path.join(sourceDraftDirectory, schema.asset.path), schema.text);
    await materializeImmutableTasksetPackage(home, { taskset: withFiles, generatedFiles: [] }, "invoice-source-files", { source: { directory: sourceDraftDirectory, packageHash: await hashTasksetDraftPackage(sourceDraftDirectory) } });
    await store.upsertTaskset(withFiles);
    const editable = (value: ModelProject) => ({ id: value.id, profileId: value.profileId, name: value.name, objective: value.objective, defaultBaseModel: value.defaultBaseModel, defaultDestinationId: value.defaultDestinationId, trainingSetup: value.trainingSetup });
    model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...editable(model), trainingSetup: { ...model.trainingSetup, tasksetRef: learningRef(withFiles) } }, model.revision));
    const { contentHash: _hash, ...binding } = input.package.rewardBinding;
    const replacement = RewardBindingSchema.parse(sealLearningContent({ ...binding, revision: 2, sources: binding.sources.map(source => ({ ...source, weight: 2 })) }));
    await store.learningRepository().transaction(model.profileId, async tx => { await tx.put("asset", schema, 0); await tx.put("binding", replacement, 1); });
    const saved = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...editable(model), trainingSetup: { ...model.trainingSetup, rewardBindingRef: learningRef(replacement) } }, model.revision));
    const derived = (await store.getTasksetRevision(saved.trainingSetup.tasksetRef!.id, saved.trainingSetup.tasksetRef!.revision))!;
    const portable = materializePortableTasksetRelease({ taskset: derived, adapterId: "asset-derived" }).tasksetRelease;
    expect(portable.tasks[0]!.artifactRefs).toEqual([asset]);
    expect(portable.tasks[0]!.requiredOutputs).toEqual([output]);
    expect(await store.learningRepository().transaction(model.profileId, tx => tx.get("package", portable.id, portable.revision))).toEqual(portable);
    const directory = path.join(home, "training", "tasksets", String(derived.environment.metadata.runtimeSourceTasksetId));
    expect(await readFile(path.join(directory, asset.path), "utf8")).toBe(text);
    expect(await readFile(path.join(directory, schema.asset.path), "utf8")).toBe(schema.text);
    expect(await readFile(path.join(sourceDirectory, "taskset.json"), "utf8")).toBe(sourceManifest);
    const captured = await exportLocalModelTasksetPackage({ store, storeDir: home, modelId: saved.id, profileId: saved.profileId });
    expect(captured.modelResources?.rewardBinding).toEqual(replacement);
    expect(Buffer.from(decodeTasksetPackageFile(captured.files.find(file => file.asset.id === asset.id)!)).toString("utf8")).toBe(text);
    expect(captured.files.some(file => file.asset.visibility !== "policy")).toBe(true);
    const changedDuringExport = vi.spyOn(store, "getModelProject")
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({ ...saved, revision: saved.revision + 1 });
    try {
      await expect(exportLocalModelTasksetPackage({ store, storeDir: home, modelId: saved.id, profileId: saved.profileId })).rejects.toThrow("changed during package export");
    } finally { changedDuringExport.mockRestore(); }
    await expect(exportLocalModelTasksetPackage({ store, storeDir: home, modelId: saved.id, profileId: "other-profile" })).rejects.toThrow("unavailable");
    await writeFile(path.join(directory, asset.path), "corrupted input");
    await expect(store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...editable(saved), trainingSetup: { ...saved.trainingSetup, rewardBindingRef: learningRef(input.package.rewardBinding) } }, saved.revision))).rejects.toThrow("immutable manifest");
    expect(await store.getModelProject(saved.id)).toEqual(saved);
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
