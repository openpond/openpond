import { defineEval } from "openpond-agent-sdk";

export default defineEval({
  name: "empty-chat-asks-for-input",
  description: "A generic request with no files should ask for the missing drawing/proposal/history context.",
  async run(t) {
    await t.send({
      prompt: "Can you help with this project?",
      channel: "openpond_chat",
    });
    t.expectIntent("request_clarification");
    t.expectTextIncludes("drawing PDF");
  },
});
