import type { TrainingBundleExport, TrainingBundleManifest, TrainingPlan } from "@openpond/contracts";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { baselineTaskset, createTrainingChat, initializeTrainingProfile, materializeTasksetFromSessions, openTrainingPage, registerTrainingModel } from "./training-helpers";

export default desktopScenario({
  name: "taskset-training-handoff",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    const model = await registerTrainingModel(harness, "handoff");
    await initializeTrainingProfile(harness);
    const sessions = [await createTrainingChat(harness, model, "Handoff workflow A", "Prepare handoff A."), await createTrainingChat(harness, model, "Handoff workflow B", "Prepare handoff B.")];
    const { taskset } = await materializeTasksetFromSessions(harness, sessions);
    const ready = await baselineTaskset(harness, taskset, model);
    const recipe = fixtureRecipe();
    const plan = await harness.api.fetchJson<TrainingPlan>("/v1/training/plans", { method: "POST", body: { tasksetId: ready.id, destinationId: "export", recipe, exportApproved: true } });
    const built = await harness.api.fetchJson<{ manifest: TrainingBundleManifest }>("/v1/training/bundles", { method: "POST", body: { planId: plan.id } });
    const portable = await harness.api.fetchJson<TrainingBundleExport>(`/v1/training/bundles/${built.manifest.id}/download`);
    harness.recordAssertion("readinessPassed", ready.readiness?.ready === true);
    harness.recordAssertion("privacySafe", !portable.manifest.containsRawChats && !portable.manifest.containsSecrets && !portable.manifest.containsHiddenGraderAssets);
    harness.recordAssertion("portableFiles", portable.files.length === portable.manifest.files.length);
    await openTrainingPage(harness);
    await harness.renderer.assertText(ready.name, { label: "handoff Taskset visible" });
    await harness.screenshot("taskset-training-handoff");
  },
});

function fixtureRecipe() { return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v2-seed-17-context-512", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: 64 }, lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: 0.01, epochs: 1, maxSteps: 2, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } }; }
