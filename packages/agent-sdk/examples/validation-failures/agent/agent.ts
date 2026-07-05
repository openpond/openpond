import {
  action,
  defineAgentProject,
  defineEval,
  defineSkill,
  defineWorkflow,
  secret,
  volume,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { schedule } from "openpond-agent-sdk/schedules";

const replyWorkflow = defineWorkflow({
  name: "reply",
  description: "Return a simple reply.",
  async run(_ctx, input) {
    return { text: `Reply: ${String(input.prompt ?? "")}`, intent: "reply" };
  },
});

export default defineAgentProject({
  name: "validation-failures",
  version: "0.1.0",
  useCase: "negative-validation",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: "./agent/instructions.md",
  defaultAction: "chat",
  actions: [
    action("chat", {
      target: { kind: "workflow", workflow: replyWorkflow },
      outputArtifacts: ["artifacts/reply.json"],
    }),
  ],
  workflows: [replyWorkflow],
  channels: [
    defineChannel({
      id: "slack",
      target: { action: "chat" },
      requiredConnections: ["slack"],
      capabilities: ["slack.message.ingest"],
      normalizeEvent: (event) => ({ prompt: String(event.text ?? ""), channel: "slack" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
  ],
  env: [
    secret.env("OPENAI_API_KEY", {
      required: true,
      description: "Required platform secret binding.",
    }),
    secret.env("", {
      required: true,
      description: "Invalid declaration used to prove env_name_required.",
    }),
  ],
  volumes: [
    volume("state", "/workspace/volumes/state", {
      provisioning: { mode: "select-or-create", scope: "project" },
      state: { engine: "filesystem" },
      usedBy: ["missing-action"],
    }),
  ],
  schedules: [
    schedule.cron("daily-summary", {
      target: { action: "chat" },
      cron: "0 9 * * *",
      timezone: "America/New_York",
      enabledByDefault: false,
      input: { prompt: "Summarize yesterday.", channel: "schedule" },
    }),
  ],
  skills: [
    defineSkill({
      name: "unsafe-skill",
      description: "Declares an unsafe generated sibling path.",
      source: "This skill is intentionally invalid.",
      files: {
        "../outside.md": "This path must not be allowed.",
      },
    }),
  ],
  evals: [
    defineEval({
      name: "missing-artifact",
      description: "Expects an artifact no action declares.",
      expectedArtifacts: ["artifacts/missing.json"],
      async run(t) {
        await t.send({ prompt: "hello", channel: "slack" });
      },
    }),
  ],
});
