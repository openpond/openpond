import {
  defineIntent,
  defineIntentRouter,
  defineWorkflow,
  type AgentChatInput,
} from "openpond-agent-sdk";

export const draftReplyWorkflow = defineWorkflow({
  name: "draft-customer-reply",
  description: "Draft a customer-facing reply from the user's request.",
  async run(ctx, input) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "the customer request";
    ctx.trace.event("customer_reply.draft.started");
    return {
      text: `Thanks for reaching out. I understand the issue: ${prompt}. I can help with the next step and keep you updated as we work through it.`,
      intent: "draft_customer_reply",
    };
  },
});

export const draftReplyIntent = defineIntent<AgentChatInput>({
  name: "draft_customer_reply",
  description: "Draft a customer-facing reply.",
  when(input) {
    const text = input.prompt.toLowerCase();
    return text.includes("reply") || text.includes("customer") || text.includes("respond");
  },
  async run(ctx, input) {
    return ctx.workflow("draft-customer-reply", input);
  },
});

export const requestContextIntent = defineIntent<AgentChatInput>({
  name: "request_context",
  description: "Ask for customer context before drafting.",
  async run() {
    return {
      text: "Send the customer message and the outcome you want, then I can draft the reply.",
      intent: "request_context",
      needsUserInput: true,
    };
  },
});

export const customerReplyRouter = defineIntentRouter({
  inputSchema: "AgentChatInput",
  intents: [draftReplyIntent, requestContextIntent],
  defaultIntent: requestContextIntent,
  routing: { strategy: "code", traceSelection: true },
});
