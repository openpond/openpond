import {
  action,
  defineAgentProject,
  defineIntent,
  defineIntentRouter,
  editable,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEval } from "openpond-agent-sdk/eval";
import { defineInstructions } from "openpond-agent-sdk/instructions";
import { integration } from "openpond-agent-sdk/integrations";
import { defineSkill } from "openpond-agent-sdk/skills";

const draftReply = defineIntent({
  name: "draft_reply",
  description: "Draft a customer reply.",
  async run(ctx, input) {
    await ctx.loadSkill("reply-style");
    return {
      text: `Thanks for reaching out. ${input.prompt}`,
      intent: "draft_reply",
    };
  },
});

const chat = defineIntentRouter({
  intents: [draftReply],
  defaultIntent: draftReply,
  routing: { strategy: "code" },
});

export default defineAgentProject({
  name: "customer-reply-agent",
  version: "0.1.0",
  useCase: "customer-reply",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "reply-style",
      description: "Use when drafting customer-facing responses.",
      source: "Be specific, calm, and avoid over-promising.",
    }),
  ],
  integrations: [
    integration.slack({ required: false, capabilities: ["slack.message.ingest"] }),
  ],
  defaultAction: "chat",
  actions: [action("chat", { target: { kind: "intent-router", router: chat } })],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
    defineChannel({
      id: "slack",
      target: { action: "chat" },
      requiredConnections: ["slack"],
      capabilities: ["slack.message.ingest"],
      normalizeEvent: (event) => ({ prompt: String(event.text ?? ""), channel: "slack" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
  ],
  editable: editable({
    enabled: true,
    backend: "openpond-coding-work-item",
    runtimeEnvironmentId: "openpond-coding-core-v1",
    sourceOfTruth: "agent-source",
    policyDiscovery: { command: "openpond agent inspect --json", runAfter: "source-materialized" },
    allowedPaths: ["agent/**", "src/**", "package.json"],
    requiredChecks: ["openpond-agent validate", "openpond-agent eval"],
    defaultResultMode: "patch_only",
  }),
  evals: [
    defineEval({
      name: "drafts-reply",
      description: "The reply template drafts a customer response.",
      async run(t) {
        await t.send({ prompt: "I need an update on my order.", channel: "openpond_chat" });
        t.expectIntent("draft_reply");
        t.expectTextIncludes("Thanks");
      },
    }),
  ],
});
