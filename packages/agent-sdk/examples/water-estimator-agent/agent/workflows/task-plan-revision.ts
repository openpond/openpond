import { defineIntent, defineWorkflow, type AgentChatInput } from "openpond-agent-sdk";

export const taskPlanRevisionWorkflow = defineWorkflow({
  name: "task-plan-revision",
  description: "Approve, reject, export, rename, or edit a generated task plan.",
  async run(ctx, input) {
    ctx.trace.event("task_plan_revision.started");
    await ctx.runCommand("pnpm revise-task-plan", { input });
    ctx.trace.artifact("artifacts/task-plan-revision.json");
    return {
      text: "OpenPond applied the task-plan revision and exported the updated version.",
      intent: "task_plan_revision",
      artifactRefs: [
        "artifacts/task-plan-revision.json",
        "artifacts/task-plan-v2.csv",
        "artifacts/task-plan-v2.xlsx",
        "artifacts/task-plan-approved.csv",
        "artifacts/task-plan-approved.xlsx",
      ],
    };
  },
});

export const taskPlanRevisionIntent = defineIntent<AgentChatInput>({
  name: "task_plan_revision",
  description: "Handle task-plan approval, rejection, export, rename, and task edits.",
  when(input) {
    const text = `${input.prompt} ${JSON.stringify(input.context ?? {})}`.toLowerCase();
    return (
      text.includes("approve") ||
      text.includes("reject") ||
      text.includes("rename") ||
      text.includes("edit task") ||
      text.includes("export") ||
      text.includes("combine") ||
      text.includes("split")
    );
  },
  async run(ctx, input) {
    return ctx.workflow("task-plan-revision", input);
  },
});
