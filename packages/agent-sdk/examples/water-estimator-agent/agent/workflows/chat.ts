import {
  defineIntent,
  defineIntentRouter,
  type AgentChatInput,
} from "openpond-agent-sdk";

import { generateEstimateReviewIntent } from "./generate-estimate-review";
import { generateTaskPlanIntent } from "./generate-task-plan";
import { taskPlanHistoryIntent } from "./task-plan-history";
import { taskPlanRevisionIntent } from "./task-plan-revision";

export const requestClarificationIntent = defineIntent<AgentChatInput>({
  name: "request_clarification",
  description: "Ask for missing drawing, proposal, history, or revision context.",
  async run(_ctx, input) {
    const channelText =
      input.channel === "microsoft_teams"
        ? "Upload a drawing PDF or paste a SharePoint/OneDrive link in this thread."
        : "Attach a drawing PDF, history spreadsheet, proposal file, or tell me which saved task plan to update.";
    return {
      text: `I need one more input before I can run the water estimator. ${channelText}`,
      intent: "request_clarification",
      needsUserInput: true,
    };
  },
});

export const waterEstimatorChatRouter = defineIntentRouter({
  inputSchema: "AgentChatInput",
  routing: {
    strategy: "model-or-code",
    model: "openpond-chat",
    traceSelection: true,
  },
  intents: [
    generateTaskPlanIntent,
    generateEstimateReviewIntent,
    taskPlanHistoryIntent,
    taskPlanRevisionIntent,
    requestClarificationIntent,
  ],
  defaultIntent: requestClarificationIntent,
});
