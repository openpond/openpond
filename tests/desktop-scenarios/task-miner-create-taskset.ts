import type { TaskCandidate, TaskCreationSnapshot } from "@openpond/contracts";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { addTrainingSource, createTrainingChat, initializeTrainingProfile, openTrainingPage, registerTrainingModel, trainingState } from "./training-helpers";

export default desktopScenario({
  name: "task-miner-create-taskset",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    const model = await registerTrainingModel(harness, "miner");
    await initializeTrainingProfile(harness);
    const sessions = [];
    for (let index = 0; index < 3; index += 1) sessions.push(await createTrainingChat(harness, model, "Weekly expert judgment review", `Review expert judgment case ${index}.`));
    await Promise.all(sessions.map((session) => addTrainingSource(harness, session.id)));
    const candidates = await harness.api.fetchJson<TaskCandidate[]>("/v1/training/miner/run", { method: "POST", body: { profileId: "default", sourceIds: [] } });
    if (candidates.length !== 1) throw new Error(`Expected one mined candidate, received ${candidates.length}.`);
    const creation = await harness.api.fetchJson<TaskCreationSnapshot>(`/v1/training/candidates/${candidates[0]!.id}/create`, { method: "POST", body: { mode: "defaults", analysisModel: null } });
    const ready = await harness.api.fetchJson<TaskCreationSnapshot>(`/v1/training/task-creations/${creation.id}/materialize`, { method: "POST", body: { approved: true } });
    const state = await trainingState(harness);
    harness.recordAssertion("candidateEvidenceCount", candidates[0]!.evidence.length === 3);
    harness.recordAssertion("sameCreatorPipeline", ready.request.surface === "task_candidate");
    harness.recordAssertion("tasksetMaterialized", state.tasksets.some((item) => item.id === ready.materializedTasksetId));
    await openTrainingPage(harness);
    await harness.renderer.assertText("AI suggestions", { label: "Automated suggestions content", timeoutMs: 30_000 }).catch(async () => {
      await harness.renderer.evaluate(`(() => { const tab = [...document.querySelectorAll('[role=tab]')].find((item) => item.textContent?.includes('Models')); if (tab instanceof HTMLElement) tab.click(); return true; })()`);
      await harness.renderer.assertText("AI suggestions");
    });
    await harness.screenshot("task-miner-create-taskset");
  },
});
