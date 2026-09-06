import { expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TasksetSourceRefSchema } from "@openpond/contracts";
import { learningRef, sealLearningContent, TaskDefinitionSchema } from "@openpond/evals/learning";
import { createModelStarterCreationRequest, validateResolvedModelStarter } from "openpond-sdk/model-starters";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { withTempDirectory } from "./helpers/temp-directory.js";
import starterImportFixture from "./fixtures/model-starter-import.json";
import { prepareModelStarterTaskset } from "../apps/server/src/training/model-starter-taskset.js";
import { createModelStarterCreationService } from "../apps/server/src/training/model-starter-creation-service.js";
import { createModelStarterRuntime } from "../apps/server/src/training/model-starter-runtime.js";

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

it("rolls back imported resources when a later immutable dependency conflicts", async () => withTempDirectory("starter-rollback-", async home => {
  const store = new SqliteStore(home);
  try {
    const input = await starterInput();
    const { contentHash: _hash, ...definition } = input.package.taskDefinition;
    const conflict = TaskDefinitionSchema.parse(sealLearningContent({ ...definition, description: "An existing different definition" }));
    await store.learningRepository().transaction(input.request.profileId, async tx => { await tx.put("definition", conflict, 0); });
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
