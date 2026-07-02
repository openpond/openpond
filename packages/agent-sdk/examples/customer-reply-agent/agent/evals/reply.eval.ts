import { defineEval } from "openpond-agent-sdk";

export default defineEval({
  name: "drafts-customer-reply",
  description: "A customer reply request should route to the reply drafting workflow.",
  async run(t) {
    await t.send({
      prompt: "Draft a reply to a customer asking when their install will be scheduled.",
      channel: "openpond_chat",
    });
    t.expectIntent("draft_customer_reply");
    t.expectTextIncludes("Thanks for reaching out");
    t.expectTraceEvent("customer_reply.draft.started");
  },
});
