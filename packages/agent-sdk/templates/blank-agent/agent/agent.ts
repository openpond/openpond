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
import { defineSkill } from "openpond-agent-sdk/skills";

const answer = defineIntent({
  name: "answer",
  description: "Answer a simple user prompt.",
  async run(_ctx, input) {
    return { text: `Answer: ${input.prompt}`, intent: "answer" };
  },
});

const chat = defineIntentRouter({
  intents: [answer],
  defaultIntent: answer,
  routing: { strategy: "code" },
});

export default defineAgentProject({
  name: "blank-agent",
  version: "0.1.0",
  useCase: "blank-agent",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "basic",
      description: "Use for straightforward responses.",
      source: "Keep the answer short and concrete.",
    }),
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
      name: "answers",
      description: "The blank agent answers a simple prompt.",
      async run(t) {
        await t.send({ prompt: "hello", channel: "openpond_chat" });
        t.expectIntent("answer");
        t.expectTextIncludes("hello");
      },
    }),
  ],
});
