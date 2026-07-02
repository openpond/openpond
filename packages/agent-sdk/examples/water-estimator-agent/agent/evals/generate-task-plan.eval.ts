import { defineEval } from "openpond-agent-sdk";

export default defineEval({
  name: "drawing-pdf-generates-task-plan",
  description: "A drawing PDF should route to generate_task_plan and produce task-plan artifacts.",
  async run(t) {
    await t.send({
      prompt: "Generate a task plan for this drawing set.",
      channel: "openpond_chat",
      files: [{ ref: "fixtures/synthetic-water-plan.pdf", name: "synthetic-water-plan.pdf" }],
    });
    t.expectIntent("generate_task_plan");
    t.expectTraceEvent("intent.selected");
    t.expectArtifact("artifacts/task-plan.xlsx");
    t.expectArtifact("artifacts/consolidated-task-plan.json");
  },
});
