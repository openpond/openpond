import {
  action,
  defineAgentProject,
  defineIntent,
  defineIntentRouter,
  editable,
  secret,
  volume,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEval } from "openpond-agent-sdk/eval";
import { defineInstructions } from "openpond-agent-sdk/instructions";
import { defineIntegration, integration } from "openpond-agent-sdk/integrations";
import { schedule } from "openpond-agent-sdk/schedules";
import { defineSkill } from "openpond-agent-sdk/skills";

const summarize = defineIntent({
  name: "summarize",
  description: "Summarize a project update.",
  async run(ctx, input) {
    const text = await ctx.model("summary", async () => `Summary: ${input.prompt}`);
    ctx.trace.artifact("artifacts/summary.json", { kind: "summary" });
    return { text, intent: "summarize", artifactRefs: ["artifacts/summary.json"] };
  },
});

const chat = defineIntentRouter({
  intents: [summarize],
  defaultIntent: summarize,
  routing: { strategy: "code" },
});

export default defineAgentProject({
  name: "integration-heavy-agent",
  version: "0.1.0",
  useCase: "integration-heavy",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  resources: { cpu: 2, memoryGb: 4, diskGb: 20 },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "summary-style",
      description: "Use when creating project summaries.",
      source: "Highlight blockers, owners, and next steps.",
    }),
  ],
  env: [
    secret.env("OPENAI_API_KEY", {
      required: true,
      description: "Model provider key stored in OpenPond secret storage.",
    }),
  ],
  integrations: [
    integration.slack({ required: true, capabilities: ["slack.message.send"] }),
    integration.opchat({ required: true, scopes: ["opchat:chat:create"] }),
    defineIntegration({
      provider: "github",
      required: false,
      capabilities: ["github.issue.read"],
    }),
  ],
  volumes: [
    volume("project-state", "/workspace/volumes/project-state", {
      provisioning: {
        mode: "select-or-create",
        scope: "project",
        ui: { label: "Project state", required: true },
      },
      state: { engine: "filesystem" },
    }),
  ],
  defaultAction: "chat",
  actions: [
    action("chat", {
      target: { kind: "intent-router", router: chat },
      outputArtifacts: ["artifacts/summary.json"],
    }),
  ],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text, artifactRefs: result.artifactRefs }),
    }),
    defineChannel({
      id: "slack",
      target: { action: "chat" },
      requiredConnections: ["slack"],
      capabilities: ["slack.message.send"],
      normalizeEvent: (event) => ({ prompt: String(event.text ?? ""), channel: "slack" }),
      renderResponse: (result) => ({ text: result.text, artifactRefs: result.artifactRefs }),
    }),
  ],
  schedules: [
    schedule.cron("weekday-summary", {
      target: { action: "chat" },
      cron: "0 9 * * MON-FRI",
      timezone: "America/New_York",
      enabledByDefault: false,
      input: { prompt: "Prepare a weekday project summary.", channel: "schedule" },
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
      name: "summarizes-update",
      description: "The integration-heavy template summarizes an update and produces an artifact.",
      publishGate: true,
      async run(t) {
        await t.send({ prompt: "Project is blocked on design review.", channel: "openpond_chat" });
        t.expectIntent("summarize");
        t.expectArtifact("artifacts/summary.json");
        t.expectTraceEvent("model.completed");
      },
    }),
  ],
});
