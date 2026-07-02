import {
  defineIntent,
  defineIntentRouter,
  defineWorkflow,
  type AgentChatInput,
} from "openpond-agent-sdk";

export const answerWorkflow = defineWorkflow({
  name: "answer",
  description: "Return a concise answer for a specific user request.",
  async run(ctx, input) {
    ctx.trace.event("blank.answer.started");
    return {
      text: `I can help with: ${(input.prompt as string).trim()}`,
      intent: "answer",
    };
  },
});

export const answerIntent = defineIntent<AgentChatInput>({
  name: "answer",
  description: "Answer when the prompt contains a specific request.",
  when(input) {
    return input.prompt.trim().length > 12;
  },
  async run(ctx, input) {
    return ctx.workflow("answer", input);
  },
});

export const requestClarificationIntent = defineIntent<AgentChatInput>({
  name: "request_clarification",
  description: "Ask for more detail when the request is too vague.",
  async run() {
    return {
      text: "What should this agent help with first?",
      intent: "request_clarification",
      needsUserInput: true,
    };
  },
});

export const blankChatRouter = defineIntentRouter({
  inputSchema: "AgentChatInput",
  intents: [answerIntent, requestClarificationIntent],
  defaultIntent: requestClarificationIntent,
  routing: { strategy: "code", traceSelection: true },
});
