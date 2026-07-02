import { defineEval } from "openpond-agent-sdk";

export default defineEval({
  name: "vague-request-asks-clarifying-question",
  description: "The blank agent should ask a clarifying question for vague prompts.",
  async run(t) {
    await t.send({ prompt: "Help", channel: "openpond_chat" });
    t.expectIntent("request_clarification");
    t.expectTextIncludes("What should this agent help with first?");
  },
});
