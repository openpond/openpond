import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TrainingPreparationPlanSchema } from "@openpond/contracts";
import { TrainingAdapterRegistry, TrainingDestinationRegistry } from "@openpond/training-sdk";
import { computeTasksetHash, sha256 } from "@openpond/taskset-sdk";
import { createModelProjectSaveRequest, ModelProjectTrainingSetupSchema } from "openpond-sdk/model-projects";
import { SqliteStore } from "../apps/server/src/store/store";
import { withTempDirectory } from "./helpers/temp-directory";
import { sftRecipeFixture, tasksetFixture } from "./helpers/training-fixtures";
import { createPortableModelRunService } from "../apps/server/src/training/portable-model-run-service";
import { createTrainingPlanLifecycleService } from "../apps/server/src/training/training-plan-lifecycle-service";
import { PortablePreparationTrainingDestination } from "../apps/server/src/training/destinations";
import { requireReleasedTaskset } from "../apps/server/src/training/local-taskset-release";
import { compileDesktopHarnessContext } from "../apps/server/src/training/portable-evals-adapter";
import { checkModelProjectConfiguration } from "../apps/server/src/training/model-project-configuration-check";

// A second window must not overwrite a stale Model, and retrying a lost response
// must return the committed receipt even if another window has edited it since.
test("saves model configuration with exact ownership, revisions, and durable retry identity", async () => withTempDirectory("model-authoring-", async (home) => {
  const first = new SqliteStore(home);
  await first.listModelProjects();
  const second = new SqliteStore(home);
  try {
    await second.listModelProjects();
    const taskset = await first.upsertTaskset(tasksetFixture());
    const project = {
      id: "model-authoring", profileId: "default", name: "Greeting model", objective: "Learn approved greetings",
      defaultBaseModel: null, defaultDestinationId: null,
      trainingSetup: ModelProjectTrainingSetupSchema.parse({ tasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } }),
    };
    const request = await createModelProjectSaveRequest(project, 0);
    const check = (input: unknown) => checkModelProjectConfiguration({ store: first, request: input, destinations: async () => [] });
    const checked = await check(request);
    expect(checked.canSave).toBe(true);
    expect(checked.deferred).toEqual(["base_model"]);
    expect(await first.listModelProjects()).toHaveLength(0);
    const unavailable = await check(await createModelProjectSaveRequest({ ...project,
      defaultBaseModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: "unavailable", revision: null,
        tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" },
    }, 0));
    expect(unavailable).toMatchObject({ canSave: false, findings: expect.arrayContaining([expect.objectContaining({ code: "model_base_unavailable" })]) });
    expect(unavailable.configurationHash).not.toBe(checked.configurationHash);
    const saved = await first.saveModelProjectConfiguration(request);
    expect(saved.revision).toBe(1);
    expect(saved.trainingSetup.tasksetRef).toEqual(project.trainingSetup.tasksetRef);
    expect(await second.saveModelProjectConfiguration(await createModelProjectSaveRequest(project, 0))).toEqual(saved);
    const edits = await Promise.allSettled([
      first.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, name: "First edit" }, 1)),
      second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, name: "Second edit" }, 1)),
    ]);
    expect(edits.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409, code: "model_revision_conflict" } });
    expect((await first.getModelProject(project.id))?.revision).toBe(2);
    expect((await check(request)).canSave).toBe(true);
    expect(await check(await createModelProjectSaveRequest({ ...project, name: "Stale new configuration" }, 1)))
      .toMatchObject({ canSave: false, findings: expect.arrayContaining([expect.objectContaining({ code: "model_revision_conflict" })]) });
    expect(await second.saveModelProjectConfiguration(request)).toEqual(saved);
    await expect(second.saveModelProjectConfiguration({ ...request, project: { ...project, name: "Reused operation" } })).rejects.toMatchObject({ status: 409, code: "model_operation_conflict" });
    await expect(second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, profileId: "other" }, 2))).rejects.toMatchObject({ status: 404, code: "model_not_found" });
    await expect(second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, id: "other-model", profileId: "other" }, 0))).rejects.toMatchObject({ status: 404, code: "model_taskset_not_found" });
    expect(await second.getModelProject("other-model")).toBeNull();
    await expect(second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, id: "wrong-hash", trainingSetup: { ...project.trainingSetup, tasksetRef: { ...project.trainingSetup.tasksetRef!, contentHash: "f".repeat(64) } } }, 0))).rejects.toMatchObject({ status: 409, code: "model_taskset_changed" });
    expect(await second.getModelProject("wrong-hash")).toBeNull();
  } finally {
    await second.close();
    await first.close();
  }
  const reopened = new SqliteStore(home);
  try {
    expect((await reopened.getModelProject("model-authoring"))?.revision).toBe(2);
    expect(await reopened.listModelProjects()).toHaveLength(1);
  } finally { await reopened.close(); }
}));

// Run admission must retain its Taskset and Model snapshot when another window
// edits both while preparation is in flight; producing a quote must not undo it.
test("prepares an immutable run without overwriting a concurrent Model edit", async () => withTempDirectory("model-admission-", async (home) => {
  const store = new SqliteStore(home);
  try {
    const taskset = await store.upsertTaskset(tasksetFixture({ ready: true }));
    const publishedRelease = await requireReleasedTaskset({ releaseForTaskset: async () => null }, taskset);
    expect(compileDesktopHarnessContext({ taskset, tasksetRelease: publishedRelease, model: { providerId: "openpond", modelId: "fixture" } }).tasksetRelease).toEqual(publishedRelease);
    const reference = { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
    const recipe = sftRecipeFixture();
    const project = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({
      id: "admitted-model", profileId: taskset.profileId, name: "Before edit", objective: null,
      defaultBaseModel: null, defaultDestinationId: "openpond_managed",
      trainingSetup: ModelProjectTrainingSetupSchema.parse({
        tasksetRef: reference, recipe, method: "sft", destinationId: "openpond_managed",
        baseModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: recipe.baseModel.id,
          revision: recipe.baseModel.revision, tokenizerRevision: recipe.baseModel.tokenizerRevision,
          chatTemplateHash: sha256("admitted-template"), source: "local", modelAssetId: null },
      }),
    }, 0));
    const registry = new TrainingDestinationRegistry();
    registry.register(new PortablePreparationTrainingDestination("openpond_managed", {
      resolveTaskset: (id, hash) => store.getTasksetByHash(id, hash),
      estimatedCostUsd: 0, methods: ["sft"], environmentPlacements: ["local", "remote"], assumptions: [],
    }));
    const lifecycle = createTrainingPlanLifecycleService({ store, storeDir: home, registry,
      projectArtifactRows: async () => { throw new Error("Fixture has inline training rows."); },
    });
    const stop = new Error("Prepared fixture without launching compute");
    let prepared = false;
    const service = createPortableModelRunService({
      store, storeDir: home, adapters: new TrainingAdapterRegistry(),
      catalog: async () => { throw new Error("No compute launch in this boundary test."); },
      approve: async () => { throw new Error("No compute approval in this boundary test."); },
      resolveReleasedHarness: async ({ modelProject }) => {
        expect(modelProject).toEqual(project);
        await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({
          id: project.id, profileId: project.profileId, name: "Concurrent edit", objective: project.objective,
          defaultBaseModel: project.defaultBaseModel, defaultDestinationId: project.defaultDestinationId,
          trainingSetup: project.trainingSetup,
        }, 1));
        const newer = { ...taskset, revision: taskset.revision + 1, name: "New Taskset revision" };
        newer.tasks = taskset.tasks.map((task) => ({ ...task, expectedOutput: { text: "Changed target" } }));
        newer.contentHash = computeTasksetHash(newer);
        await store.upsertTaskset(newer);
        return { harnessRelease: { id: "harness-admission", contentHash: sha256("harness-admission") },
          tasksetRelease: { id: "taskset-admission", contentHash: sha256("taskset-admission") } };
      },
      prepare: async ({ modelProject }) => {
        expect(modelProject.name).toBe("Before edit");
        expect(modelProject.revision).toBe(1);
        expect(modelProject.trainingSetup.tasksetRef).toEqual(reference);
        return TrainingPreparationPlanSchema.parse({ schemaVersion: "openpond.trainingPreparationPlan.v1",
          modelRunId: "admission", state: "ready", reason: null, runtime: null, compute: null, engine: null,
          downloads: [], dataMovement: [], quoteUsd: 0, maximumSpendUsd: 0, retentionDays: null,
          sideEffectsStarted: false, contentHash: sha256("prepared") });
      },
      prepareStart: async (input) => {
        expect(input.tasksetRef).toEqual(reference);
        const result = await lifecycle.prepareStart(input);
        expect(result.plan.tasksetHash).toBe(reference.contentHash);
        const bundle = await lifecycle.buildBundle(result.plan.id);
        const rows = await readFile(path.join(bundle.directory, "data/train.jsonl"), "utf8");
        expect(rows).toContain("Hello friend");
        expect(rows).not.toContain("Changed target");
        prepared = true;
        throw stop;
      },
    });
    await expect(service.start({ modelProjectId: project.id, maximumSpendUsd: 0, exportApproved: true })).rejects.toBe(stop);
    expect(prepared).toBe(true);
    const saved = await store.getModelProject(project.id);
    expect(saved?.name).toBe("Concurrent edit");
    expect(saved?.revision).toBe(2);
    expect(saved?.trainingSetup.harnessRelease).toBeNull();
    expect(saved?.trainingSetup.tasksetRef).toEqual(reference);
    const hostedReceipt = { ...project, hosted: {
      schemaVersion: "openpond.hostedModelProjectLink.v1" as const, teamId: "team-1", projectId: "hosted-model",
      portableProjectId: project.id, revision: 1, etag: sha256("hosted-revision"), syncedSourceRevision: 1,
      syncedAt: new Date().toISOString(), tasksets: [],
    } };
    const linked = await store.saveModelProjectHosting(project, hostedReceipt);
    expect(linked.name).toBe("Concurrent edit");
    expect(linked.revision).toBe(2);
    expect(linked.hosted?.syncedSourceRevision).toBe(1);
    await expect(store.saveModelProjectHosting(project, hostedReceipt, true)).rejects.toMatchObject({ status: 409, code: "model_hosting_conflict" });
    expect((await store.getModelProject(project.id))?.name).toBe("Concurrent edit");
  } finally { await store.close(); }
}));
