import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import { createTrainingChat, initializeTrainingProfile, materializeTasksetFromSessions, openTrainingPage, registerTrainingModel } from "./training-helpers";

export default desktopScenario({
  name: "chats-to-training-taskset",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    const model = await registerTrainingModel(harness, "manual");
    await initializeTrainingProfile(harness);
    const sessions = await Promise.all([
      createTrainingChat(harness, model, "Approved research workflow A", "Research account health and write the update."),
      createTrainingChat(harness, model, "Approved research workflow B", "Research product health and write the update."),
    ]);
    const result = await materializeTasksetFromSessions(harness, sessions);
    harness.recordAssertion("materialized", Boolean(result.taskset.id));
    harness.recordAssertion("clusterIsolation", new Set(result.taskset.tasks.map((task) => `${task.clusterKey}:${task.split}`)).size === result.taskset.tasks.length);
    harness.recordAssertion("fixturesGenerated", result.taskset.graderFixtures.length === 6);
    await openTrainingPage(harness);
    await harness.renderer.assertText(result.taskset.name, { label: "materialized Taskset visible" });
    await harness.screenshot("chats-to-training-taskset");
  },
});
