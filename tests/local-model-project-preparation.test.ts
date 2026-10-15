import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { createLearningTextAsset, learningRef } from "@openpond/evals/learning";
import { createRewardBinding, createRewardRelease } from "@openpond/evals/rewards";
import { compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import type { LocalDatasetRecord } from "@openpond/contracts";
import { runTrainingCommand } from "../apps/cli/src/cli/training";
import { SqliteStore } from "../apps/server/src/store/store";
import { createLocalDatasetService } from "../apps/server/src/training/local-dataset-service";
import { parseLocalModelProjectPreparation } from "../apps/server/src/training/local-model-project-preparation";

// Failure story: preparing a Dataset for training must not publish anything;
// applying a changed receipt or conflicting dependency must not partially save
// resources, rewrite source bytes/splits, or replace the reviewed recipe.
test("local project preparation publishes only its exact reviewed closure atomically and recovers retries", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-project-preparation-"));
  const store = new SqliteStore(home);
  const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const code = "export function verify({task,attempt}) { const passed=attempt.output.text===task.expectedOutput.text; return {passed,score:passed?1:0,feedback:'Checked'}; }\n";
    const created = await createLocalDatasetService({ store, home }).request({ action: "create", operationId: "preparation-source", payload: {
      name: "Preparation source", draft: { objective: "Return the saved answer.",
        tasks: ["train", "validation", "test"].map(split => ({ schemaVersion: "openpond.taskData.v1", id: split, clusterKey: `${split}-family`, split,
          input: { prompt: `Answer ${split}` }, expectedOutput: { text: split }, policyVisibleContext: {}, privilegedContextRef: null, sourceRefs: [], tags: [], metadata: {} })),
        graders: [{ id: "exact", version: "1", label: "Exact", kind: "custom_verifier", runtime: "isolated_javascript", module: "graders/original.js", exportName: "verify", timeoutMs: 1000, networkPolicy: "none", weight: 1, hardGate: true, rewardEligible: false, privileged: true, metadata: {} }],
      }, files: [{ path: "graders/original.js", contentHash: sha256(code), sizeBytes: Buffer.byteLength(code), base64: Buffer.from(code).toString("base64") }],
    } }) as { record: LocalDatasetRecord };
    const record = created.record;
    const source = compileTasksetDraftWorkspace({ workspace: record.workspace, preparation: null, adapterId: "openpond-desktop-taskset-authoring-v1", now: record.workspace.draft.updatedAt });
    const asset = createLearningTextAsset({ text: code, path: "rewards/exact.js", visibility: "verifier", mediaType: "application/javascript" });
    const reward = createRewardRelease({ schemaVersion: "openpond.rewardRelease.v1", id: "prepared-exact", revision: 1, name: "Exact", description: "", implementation: {
      kind: "custom_verifier", runtime: "isolated_javascript", verifierRef: asset.asset, exportName: "verify", timeoutMs: 1000, networkPolicy: "none",
    }, rawScore: { minimum: 0, maximum: 1 }, assets: [] });
    const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "prepared-binding", revision: 1,
      sources: (["training", "evaluation"] as const).map(role => ({ graderId: role === "evaluation" ? "exact" : "exact-training", reward: learningRef(reward), role,
        normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] })),
      aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [reward]);
    const baseModel = { schemaVersion: "openpond.baseModelPreference.v1", modelId: "Qwen/Qwen3-8B", revision: "pinned-base", tokenizerRevision: "pinned-tokenizer", chatTemplateHash: "a".repeat(64), modelAssetId: null, source: "managed" };
    const recipe = { schemaVersion: "openpond.rftRecipe.v1", method: "grpo", parameterization: "lora", baseModel: { id: baseModel.modelId, revision: baseModel.revision, tokenizerRevision: baseModel.tokenizerRevision, chatTemplateHash: baseModel.chatTemplateHash }, lora: { rank: 2 }, rollout: { groupSize: 4, maxTurns: 1, maxOutputTokens: 128 } };
    const input = { schemaVersion: "openpond.localModelProjectPreparationInput.v1", source: { ownerId: record.ownerId, datasetId: record.workspace.draft.id,
      revision: 1, workspaceHash: record.workspace.contentHash, packageHash: source.contentHash },
      project: { id: "prepared-model", profileId: "reviewed-profile", name: "Prepared", objective: "Check preparation", defaultBaseModel: baseModel, defaultDestinationId: "openpond_managed",
        trainingSetup: { baseModel, method: "grpo", recipe, destinationId: "openpond_managed", managedRolloutPlacement: "remote", preferredMaximumSpendUsd: 1 } },
      rewardBinding: binding, rewards: [reward], assets: [asset] };
    const inputFile = path.join(home, "input.json"), receiptFile = path.join(home, "receipt.json");
    await writeFile(inputFile, JSON.stringify(input));
    const request: typeof fetch = async (url, init) => {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:17874\/v1\/training\/model-project-preparations\/(prepare|apply)$/);
      const body: unknown = JSON.parse(String(init?.body));
      const value = String(url).endsWith("/apply") ? await store.applyLocalModelProjectPreparation(body) : await store.prepareLocalModelProject(body);
      return new Response(JSON.stringify(value), { status: 200 });
    };
    await runTrainingCommand({ json: true, output: receiptFile }, ["prepare-project", inputFile], { request });
    const receipt = parseLocalModelProjectPreparation(JSON.parse(await readFile(receiptFile, "utf8")));
    expect(await store.getModelProject("prepared-model")).toBeNull();
    expect(await store.getTaskset(receipt.taskset.id)).toBeNull();
    expect(await store.learningRepository().transaction("reviewed-profile", tx => tx.get("binding", binding.id, 1))).toBeNull();
    expect(receipt.package.taskset.tasks).toEqual(source.taskset.tasks);
    expect(receipt.package.taskset.tasks.map(task => task.split)).toEqual(["train", "validation", "test"]);
    for (const file of source.files) expect(receipt.package.files).toContainEqual(file);
    expect(receipt.package.taskset.id).not.toBe(source.taskset.id);
    expect(receipt.package.taskset.metadata.modelTasksetDerivation).toMatchObject({ owner: { scopeId: "reviewed-profile", modelId: "prepared-model" }, root: learningRef(source.taskset), parent: learningRef(source.taskset) });
    await expect(store.prepareLocalModelProject({ ...input, source: { ...input.source, workspaceHash: "b".repeat(64) } })).rejects.toThrow(/workspace changed/);
    await expect(store.prepareLocalModelProject({ ...input, source: { ...input.source, ownerId: "another-installation" } })).rejects.toThrow(/local owner/);
    const changed = structuredClone(receipt);
    changed.package.taskset.tasks[0]!.expectedOutput = { text: "changed" };
    const { contentHash: _hash, ...changedContent } = changed;
    changed.contentHash = contentHash(changedContent);
    await expect(store.applyLocalModelProjectPreparation(changed)).rejects.toThrow(/differs from the exact source/);
    // Force a late conflict after the importer has attempted other dependency
    // inserts; the publication transaction must roll every inserted row back.
    const { contentHash: _rewardHash, ...rewardContent } = reward;
    const conflict = createRewardRelease({ ...rewardContent, name: "Conflicting immutable resource" });
    await store.learningRepository().transaction("reviewed-profile", tx => tx.put("reward", conflict, 0));
    await expect(store.applyLocalModelProjectPreparation(receipt)).rejects.toThrow(/conflicts with an existing revision/);
    expect(await store.getTaskset(receipt.taskset.id)).toBeNull();
    expect(await store.getModelProject("prepared-model")).toBeNull();
    expect(await store.learningRepository().transaction("reviewed-profile", tx => tx.get("binding", binding.id, 1))).toBeNull();
    // A fresh explicit Profile is an independent publication scope; no failed
    // attempt may force reuse of conflicted resources or rewrite that history.
    const clean = { ...input, project: { ...input.project, profileId: "clean-profile" } };
    const reviewed = await store.prepareLocalModelProject(clean);
    const reviewedFile = path.join(home, "clean-receipt.json");
    await writeFile(reviewedFile, JSON.stringify(reviewed));
    await runTrainingCommand({ json: true, apply: true }, ["prepare-project", reviewedFile], { request });
    const saved = JSON.parse(String(logging.mock.calls.at(-1)![0]));
    expect(saved.project.trainingSetup.recipe).toEqual(recipe);
    expect(saved.project.trainingSetup.rewardBindingRef).toEqual(learningRef(binding));
    expect(saved.project.trainingSetup.tasksetRef).toEqual(learningRef(reviewed.taskset));
    expect(saved.project.trainingSetup.evaluationTasksetRef).toEqual(learningRef(reviewed.taskset));
    expect(await store.getModelProject("prepared-model")).toEqual(saved.project);
    expect(await store.getTaskset(reviewed.taskset.id)).toEqual(saved.taskset);
    expect(await store.applyLocalModelProjectPreparation(reviewed)).toEqual(saved);
    await expect(store.applyLocalModelProjectPreparation(receipt)).rejects.toThrow(/already exists/);
    expect(await store.readLocalDataset(input.source.datasetId, 1)).toEqual(record);
  } finally { logging.mockRestore(); await store.close(); await rm(home, { recursive: true, force: true }); }
}, 30_000);
