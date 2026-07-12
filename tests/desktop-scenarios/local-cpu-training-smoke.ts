import type { TrainingApproval, TrainingBundleManifest, TrainingJob, TrainingPlan } from "@openpond/contracts";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { baselineTaskset, createTrainingChat, initializeTrainingProfile, materializeTasksetFromSessions, openTrainingPage, registerTrainingModel, trainingState } from "./training-helpers";

export default desktopScenario({
  name: "local-cpu-training-smoke",
  mode: "isolated",
  timeoutMs: 180_000,
  async run(harness) {
    const model = await registerTrainingModel(harness, "cpu");
    await initializeTrainingProfile(harness);
    const sessions = [await createTrainingChat(harness, model, "CPU workflow A", "Prepare CPU example A."), await createTrainingChat(harness, model, "CPU workflow B", "Prepare CPU example B.")];
    const { taskset } = await materializeTasksetFromSessions(harness, sessions);
    const ready = await baselineTaskset(harness, taskset, model);
    const plan = await harness.api.fetchJson<TrainingPlan>("/v1/training/plans", { method: "POST", body: { tasksetId: ready.id, destinationId: "local_cpu_fixture", recipe: fixtureRecipe(), exportApproved: true } });
    const built = await harness.api.fetchJson<{ manifest: TrainingBundleManifest }>("/v1/training/bundles", { method: "POST", body: { planId: plan.id } });
    const approval = await harness.api.fetchJson<TrainingApproval>("/v1/training/approvals", { method: "POST", body: { planId: plan.id, bundleId: built.manifest.id } });
    const launched = await harness.api.fetchJson<TrainingJob>("/v1/training/launch", { method: "POST", body: { planId: plan.id, approvalId: approval.id } });
    let state = await trainingState(harness);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !["succeeded", "failed", "cancelled"].includes(state.jobs.find((item) => item.id === launched.id)?.status ?? "")) { await new Promise((resolve) => setTimeout(resolve, 250)); state = await trainingState(harness); }
    const completed = state.jobs.find((item) => item.id === launched.id);
    if (completed?.status !== "succeeded") throw new Error(`Local CPU job did not succeed: ${completed?.status} ${completed?.error ?? ""}`);
    harness.recordAssertion("adapterImported", state.artifacts.some((item) => item.jobId === launched.id && item.kind === "adapter"));
    harness.recordAssertion("frozenEvaluation", state.models.some((item) => item.jobId === launched.id && Boolean(item.frozenEvaluationArtifactId)));
    harness.recordAssertion("notPromotable", state.models.filter((item) => item.jobId === launched.id).every((item) => !item.promotable));
    await openTrainingPage(harness);
    await harness.renderer.evaluate(`(() => { const tab = [...document.querySelectorAll('[role=tab]')].find((item) => item.textContent?.includes('Models')); if (tab instanceof HTMLElement) tab.click(); return true; })()`);
    await harness.renderer.assertText(launched.id, { label: "local CPU run visible" });
    await harness.screenshot("local-cpu-training-smoke");
  },
});

function fixtureRecipe() { return { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v1-seed-17", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: 64 }, lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: 0.01, epochs: 1, maxSteps: 2, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } }; }
