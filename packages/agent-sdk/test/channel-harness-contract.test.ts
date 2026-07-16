import { describe, expect, test } from "vitest";

import {
  inspectChannelSetup,
  listChannelSetups,
  normalizeChannelEvent,
  renderChannelResponse,
} from "openpond-agent-sdk/channels";
import {
  action,
  defineAgentProject,
  defineChannel,
  defineIntegration,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";

const chatWorkflow = defineWorkflow({
  name: "chat-workflow",
  async run(_ctx, input) {
    return { text: String(input.prompt ?? ""), intent: "chat" };
  },
});

const project = defineAgentProject({
  name: "channel-harness-agent",
  version: "0.1.0",
  useCase: "channel-harness",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  defaultAction: "chat",
  actions: [
    action("chat", { target: { kind: "workflow", workflow: chatWorkflow } }),
    action("manual-review", { target: { kind: "workflow", workflow: chatWorkflow } }),
  ],
  workflows: [chatWorkflow],
  integrations: [
    defineIntegration({
      provider: "slack",
      required: false,
      capabilities: ["slack.message.ingest"],
    }),
  ],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      enabledByDefault: true,
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text, artifactRefs: result.artifactRefs ?? [] }),
    }),
    defineChannel({
      id: "slack",
      target: { action: "chat" },
      requiredConnections: ["slack"],
      capabilities: ["slack.message.ingest"],
      normalizeEvent: (event) => ({
        prompt: String(event.text ?? ""),
        channel: "slack",
        conversationId: String(event.channelId ?? ""),
        threadId: String(event.threadTs ?? ""),
      }),
      renderResponse: (result) => ({ text: result.text, thread_ts: result.metadata?.threadTs ?? null }),
    }),
    defineChannel({
      id: "microsoft_teams",
      target: { action: "chat" },
      requiredConnections: ["microsoft_teams"],
      capabilities: ["microsoft_teams.message.ingest"],
      normalizeEvent: (event) => ({
        prompt: String(event.text ?? ""),
        channel: "microsoft_teams",
        conversationId: String(event.conversationId ?? ""),
      }),
      renderResponse: (result) => ({ body: { content: result.text } }),
    }),
    defineChannel({
      id: "mcp",
      target: { action: "chat" },
      normalizeEvent: (event) => ({
        prompt: String(event.prompt ?? ""),
        channel: "mcp",
        context: { toolCallId: event.toolCallId },
      }),
      renderResponse: (result) => ({ content: [{ type: "text", text: result.text }] }),
    }),
    defineChannel({
      id: "api",
      target: { action: "chat" },
      normalizeEvent: (event) => ({
        prompt: String(event.prompt ?? ""),
        channel: "api",
        context: { requestId: event.requestId },
      }),
      renderResponse: (result) => ({ ok: true, result }),
    }),
    defineChannel({
      id: "schedule",
      target: { action: "chat" },
      normalizeEvent: (event) => ({
        prompt: String(event.prompt ?? ""),
        channel: "schedule",
        context: { scheduleName: event.scheduleName },
      }),
      renderResponse: (result) => ({ text: result.text, artifacts: result.artifactRefs ?? [] }),
    }),
    defineChannel({
      id: "manual",
      target: { action: "manual-review" },
      normalizeEvent: (event) => ({
        prompt: String(event.prompt ?? ""),
        channel: "manual",
        context: { form: event.form },
      }),
      renderResponse: (result) => ({ text: result.text, needsUserInput: result.needsUserInput ?? false }),
    }),
  ],
});

describe("channel harness contract", () => {
  test("normalizes and renders every v1 channel surface", () => {
    expect(normalizeChannelEvent(project, "openpond_chat", { prompt: "hello" })).toMatchObject({
      prompt: "hello",
      channel: "openpond_chat",
    });
    expect(normalizeChannelEvent(project, "slack", { text: "hello", channelId: "C1", threadTs: "T1" }))
      .toMatchObject({ prompt: "hello", channel: "slack", conversationId: "C1", threadId: "T1" });
    expect(normalizeChannelEvent(project, "microsoft_teams", { text: "hello", conversationId: "team-1" }))
      .toMatchObject({ prompt: "hello", channel: "microsoft_teams", conversationId: "team-1" });
    expect(normalizeChannelEvent(project, "mcp", { prompt: "hello", toolCallId: "tool-1" }))
      .toMatchObject({ prompt: "hello", channel: "mcp", context: { toolCallId: "tool-1" } });
    expect(normalizeChannelEvent(project, "api", { prompt: "hello", requestId: "req-1" }))
      .toMatchObject({ prompt: "hello", channel: "api", context: { requestId: "req-1" } });
    expect(normalizeChannelEvent(project, "schedule", { prompt: "hello", scheduleName: "daily" }))
      .toMatchObject({ prompt: "hello", channel: "schedule", context: { scheduleName: "daily" } });
    expect(normalizeChannelEvent(project, "manual", { prompt: "hello", form: "review" }))
      .toMatchObject({ prompt: "hello", channel: "manual", context: { form: "review" } });

    expect(renderChannelResponse(project, "openpond_chat", response())).toEqual({
      text: "done",
      artifactRefs: ["artifacts/out.json"],
    });
    expect(renderChannelResponse(project, "slack", response())).toEqual({
      text: "done",
      thread_ts: "T1",
    });
    expect(renderChannelResponse(project, "microsoft_teams", response())).toEqual({
      body: { content: "done" },
    });
    expect(renderChannelResponse(project, "mcp", response())).toEqual({
      content: [{ type: "text", text: "done" }],
    });
    expect(renderChannelResponse(project, "api", response())).toMatchObject({
      ok: true,
      result: { text: "done" },
    });
    expect(renderChannelResponse(project, "schedule", response())).toEqual({
      text: "done",
      artifacts: ["artifacts/out.json"],
    });
    expect(renderChannelResponse(project, "manual", { ...response(), needsUserInput: true })).toEqual({
      text: "done",
      needsUserInput: true,
    });
  });

  test("projects channel setup requirements and disabled/not-enabled states", () => {
    expect(inspectChannelSetup(project, "openpond_chat")).toMatchObject({
      id: "openpond_chat",
      targetAction: "chat",
      enabledByDefault: true,
      setupStatus: "ready",
      setupRequirements: [],
    });
    expect(inspectChannelSetup(project, "slack")).toMatchObject({
      id: "slack",
      setupStatus: "ready",
      requiredConnections: ["slack"],
      setupRequirements: [{ kind: "integration", name: "slack", required: true, satisfied: true }],
    });
    expect(inspectChannelSetup(project, "microsoft_teams")).toMatchObject({
      id: "microsoft_teams",
      setupStatus: "missing_setup",
      requiredConnections: ["microsoft_teams"],
      setupRequirements: [
        { kind: "integration", name: "microsoft_teams", required: true, satisfied: false },
      ],
    });
    expect(inspectChannelSetup(project, "manual")).toMatchObject({
      id: "manual",
      targetAction: "manual-review",
      setupStatus: "ready",
    });
    expect(listChannelSetups(project).map((setup) => setup.id)).toEqual([
      "openpond_chat",
      "slack",
      "microsoft_teams",
      "mcp",
      "api",
      "schedule",
      "manual",
    ]);
  });

  test("rejects adapters that return the wrong channel id", () => {
    const badProject = defineAgentProject({
      ...project,
      channels: [
        defineChannel({
          id: "api",
          target: { action: "chat" },
          normalizeEvent: () => ({ prompt: "hello", channel: "slack" }),
          renderResponse: (result) => ({ text: result.text }),
        }),
      ],
    });
    expect(() => normalizeChannelEvent(badProject, "api", {}))
      .toThrow("Channel api normalizeEvent returned channel slack.");
  });
});

function response() {
  return {
    text: "done",
    intent: "chat",
    artifactRefs: ["artifacts/out.json"],
    metadata: { threadTs: "T1" },
  };
}
