import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_PROTOCOL_VERSION,
  AgentJsonRpcDispatcher,
  type JsonRpcNotification,
} from "@openpond/agent-runtime";
import { afterEach, describe, expect, test } from "vitest";

import { createOpenPondServer } from "../apps/server/src/index";
import { OPENPOND_HARNESS_SCRIPTED_MODELS_ENV } from "../apps/server/src/openpond/scripted-chat-provider";

const cleanup: Array<{
  close(): Promise<void>;
  directory: string;
  priorScriptedModels: string | undefined;
}> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    await item.close();
    await rm(item.directory, { recursive: true, force: true });
    if (item.priorScriptedModels === undefined) delete process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
    else process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = item.priorScriptedModels;
  }
});

describe("OpenPond app-server JSON-RPC integration", () => {
  test("runs a real multi-turn Local thread through the same runtime as HTTP", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-rpc-"));
    const priorScriptedModels = process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
    process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = "1";
    const server = await createOpenPondServer({ port: 0, storeDir: directory, silent: true });
    cleanup.push({ close: server.close, directory, priorScriptedModels });
    const notifications: JsonRpcNotification[] = [];
    const unsubscribe = server.agentRuntime.subscribe?.((notification) => notifications.push(notification));
    const rpc = new AgentJsonRpcDispatcher(server.agentRuntime);

    const initialized = await rpc.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        client: { name: "integration-test", version: "1" },
      },
    });
    expect(initialized).toMatchObject({
      result: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        capabilities: { placement: "local" },
      },
    });
    await rpc.handle({ jsonrpc: "2.0", method: "initialized" });

    const threadResponse = await rpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: {
            providerId: "openpond",
            modelId: "openpond-scripted-chat-two-turns",
          },
          experience: "work",
          metadata: { workspaceTarget: "local" },
          title: "RPC integration",
        },
      },
    });
    const threadId = resultRecord(threadResponse).thread.id as string;

    for (const [id, prompt] of [[3, "first RPC message"], [4, "second RPC message"]] as const) {
      const response = await rpc.handle({
        jsonrpc: "2.0",
        id,
        method: "turn/start",
        params: {
          threadId,
          input: {
            prompt,
            modelRef: {
              providerId: "openpond",
              modelId: "openpond-scripted-chat-two-turns",
            },
          },
        },
      });
      expect(resultRecord(response).turn).toMatchObject({ status: "completed", prompt });
    }

    const readResponse = await rpc.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "thread/read",
      params: { threadId },
    });
    const read = resultRecord(readResponse);
    expect(read.turns).toHaveLength(2);
    expect(read.turns[0]).toMatchObject({
      harnessSnapshot: {
        harnessRelease: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        toolCatalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      metadata: { toolCatalogHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(read.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "turn.started" }),
      expect.objectContaining({ name: "assistant.delta", output: expect.stringContaining("scripted turn") }),
      expect.objectContaining({ name: "turn.completed" }),
    ]));
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "turn/started" }),
      expect.objectContaining({ method: "item/assistantDelta" }),
      expect.objectContaining({ method: "turn/completed" }),
    ]));

    const capabilities = await rpc.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "runtime/capabilities",
      params: { threadId },
    });
    expect(resultRecord(capabilities)).toMatchObject({
      tools: expect.any(Array),
      toolCatalogHash: read.turns[0].metadata.toolCatalogHash,
    });

    const harness = await rpc.handle({ jsonrpc: "2.0", id: 6, method: "harness/validate", params: {} });
    expect(resultRecord(harness)).toMatchObject({
      valid: true,
      harnessRelease: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    unsubscribe?.();
  }, 20_000);
});

function resultRecord(response: unknown): Record<string, any> {
  if (!response || typeof response !== "object" || !("result" in response)) {
    throw new Error(`Expected JSON-RPC success: ${JSON.stringify(response)}`);
  }
  return (response as { result: Record<string, any> }).result;
}
