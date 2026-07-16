import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapPayload, Session, Turn } from "@openpond/contracts";
import type { HostedChatTool } from "@openpond/cloud";
import type { HostedChatTurnDelta, HostedChatTurnInput } from "@openpond/runtime";
import { createOpenPondServer } from "../apps/server/src/index";
import {
  createScriptedOpenPondChatStream,
  OPENPOND_HARNESS_SCRIPTED_MODELS_ENV,
  scriptedOpenPondModelsEnabled,
  streamScriptedOpenPondChatTurn,
} from "../apps/server/src/openpond/scripted-chat-provider";

describe("scripted OpenPond chat provider", () => {
  test("only enables scripted models behind the explicit harness flag", () => {
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "1" })).toBe(true);
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "true" })).toBe(true);
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "0" })).toBe(false);
    expect(scriptedOpenPondModelsEnabled({})).toBe(false);
  });

  test("delegates scripted-looking models to the fallback when disabled", async () => {
    let fallbackCalled = false;
    const stream = createScriptedOpenPondChatStream(async function* fallback(input) {
      fallbackCalled = true;
      yield { type: "text_delta", text: `fallback ${input.model}`, raw: { fallback: true } };
    }, { enabled: false });

    const deltas = await collect(stream(inputFixture({ model: "openpond-scripted-chat-two-turns" })));
    expect(fallbackCalled).toBe(true);
    expect(textFromDeltas(deltas)).toBe("fallback openpond-scripted-chat-two-turns");
  });

  test("streams deterministic multi-turn chat responses", async () => {
    const deltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-chat-two-turns",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "scripted turn 1 response for: first" },
        { role: "user", content: "second" },
      ],
    })));
    expect(textFromDeltas(deltas)).toBe("scripted turn 2 response for: second");
    expect(deltas.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  test("starts a generic child and joins its completed result", async () => {
    const startDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const startCall = onlyToolCall(startDeltas);
    expect(startCall.function?.name).toBe("openpond_subagent_start");
    expect(JSON.parse(startCall.function?.arguments ?? "{}")).toMatchObject({ roleId: "research" });
    expect(JSON.parse(startCall.function?.arguments ?? "{}")).not.toHaveProperty("required");
    expect(JSON.parse(startCall.function?.arguments ?? "{}")).not.toHaveProperty("workerBrief");

    const joinDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      messages: [
        { role: "user", content: "prove the child path" },
        toolResult("openpond_subagent_start", { runId: "run_scripted_1", status: "completed" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    expect(textFromDeltas(joinDeltas)).toBe("Research subagent lifecycle complete for run_scripted_1.");
  });

  test("server routes scripted turns through the real turn runner", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-scripted-provider-"));
    const priorEnv = process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
    process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = "1";
    const server = await createOpenPondServer({ port: 0, storeDir, silent: true, version: "scripted-provider-test" });
    const modelRef = { providerId: "openpond" as const, modelId: "openpond-scripted-chat-two-turns" };
    try {
      const session = await api<Session>(server.url, server.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ provider: "openpond", modelRef, cwd: process.cwd(), title: "scripted provider test" }),
      });
      const turn = await api<Turn>(server.url, server.token, `/v1/sessions/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello harness", modelRef }),
      });
      const bootstrap = await api<BootstrapPayload>(server.url, server.token, "/v1/bootstrap?ensureProfile=0");
      const assistantText = bootstrap.events
        .filter((event) => event.sessionId === session.id && event.turnId === turn.id && event.name === "assistant.delta")
        .map((event) => event.output ?? "")
        .join("");
      expect(turn.status).toBe("completed");
      expect(assistantText).toBe("scripted turn 1 response for: hello harness");
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
      if (priorEnv === undefined) delete process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
      else process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = priorEnv;
    }
  }, 15_000);
});

function inputFixture(overrides: Partial<HostedChatTurnInput> = {}): HostedChatTurnInput {
  return { model: "openpond-scripted-chat-two-turns", messages: [{ role: "user", content: "hello" }], ...overrides };
}

function tool(name: string): HostedChatTool {
  return { type: "function", function: { name, parameters: { type: "object", properties: {} } } };
}

function toolResult(action: string, data: Record<string, unknown>) {
  return {
    role: "tool" as const,
    tool_call_id: `call_${action}`,
    content: JSON.stringify({ ok: true, action, output: `${action} completed.`, data }),
  };
}

async function collect(stream: AsyncGenerator<HostedChatTurnDelta, void, unknown>): Promise<HostedChatTurnDelta[]> {
  const deltas: HostedChatTurnDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

function textFromDeltas(deltas: HostedChatTurnDelta[]): string {
  return deltas
    .filter((delta): delta is Extract<HostedChatTurnDelta, { type: "text_delta" }> => delta.type === "text_delta")
    .map((delta) => delta.text)
    .join("");
}

function onlyToolCall(deltas: HostedChatTurnDelta[]) {
  const toolDeltas = deltas.filter((delta): delta is Extract<HostedChatTurnDelta, { type: "tool_call_delta" }> =>
    delta.type === "tool_call_delta"
  );
  expect(toolDeltas).toHaveLength(1);
  expect(toolDeltas[0]?.toolCalls).toHaveLength(1);
  return toolDeltas[0]!.toolCalls[0]!;
}

async function api<T>(serverUrl: string, token: string, route: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${serverUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
