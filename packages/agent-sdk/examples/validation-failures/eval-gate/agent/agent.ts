import {
  action,
  defineAgentProject,
  defineEval,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";

const replyWorkflow = defineWorkflow({
  name: "reply",
  description: "Return a simple reply.",
  async run(_ctx, input) {
    return { text: `Reply: ${String(input.prompt ?? "")}`, intent: "reply" };
  },
});

export default defineAgentProject({
  name: "eval-gate-failure",
  version: "0.1.0",
  useCase: "negative-eval",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: "./agent/instructions.md",
  defaultAction: "chat",
  actions: [
    action("chat", {
      target: { kind: "workflow", workflow: replyWorkflow },
    }),
  ],
  workflows: [replyWorkflow],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
  ],
  evals: [
    defineEval({
      name: "fails-gate",
      description: "Fails so publish-gate handling has a stable fixture.",
      publishGate: true,
      async run(t) {
        await t.send({ prompt: "hello", channel: "openpond_chat" });
        t.expectTextIncludes("this text is intentionally absent");
      },
    }),
  ],
});
