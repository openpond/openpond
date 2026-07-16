import { defineIntent, defineWorkflow, type AgentChatInput } from "openpond-agent-sdk";

export const taskPlanHistoryWorkflow = defineWorkflow({
  name: "task-plan-history",
  description: "Answer questions about saved task-plan runs and prior versions.",
  async run(ctx, input) {
    ctx.trace.event("task_plan_history.lookup.started");
    await ctx.runCommand("node src/task-plan-history.ts", { input });
    ctx.trace.artifact("artifacts/task-plan-history-answer.json");
    ctx.trace.artifact("artifacts/task-plan-history-candidates.json");
    return {
      text: "OpenPond found the matching saved task-plan history and prepared an answer.",
      intent: "task_plan_history",
      artifactRefs: [
        "artifacts/task-plan-history-answer.json",
        "artifacts/task-plan-history-candidates.json",
      ],
    };
  },
});

export const taskPlanHistoryIntent = defineIntent<AgentChatInput>({
  name: "task_plan_history",
  description: "Answer questions about saved task plans, lookup names, prior runs, or task ids.",
  when(input) {
    const text = `${input.prompt} ${JSON.stringify(input.context ?? {})}`.toLowerCase();
    return (
      text.includes("saved") ||
      text.includes("prior run") ||
      text.includes("lookup") ||
      text.includes("task id") ||
      text.includes("version")
    );
  },
  async run(ctx, input) {
    return ctx.workflow("task-plan-history", input);
  },
});
