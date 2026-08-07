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
    let firstTurnRequestedAt: number | null = null;
    let firstAssistantDeltaAt: number | null = null;
    const unsubscribe = server.agentRuntime.subscribe?.((notification) => {
      notifications.push(notification);
      if (notification.method === "item/assistantDelta" && firstAssistantDeltaAt === null) {
        firstAssistantDeltaAt = performance.now();
      }
    });
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
      if (id === 3) firstTurnRequestedAt = performance.now();
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
    expect(firstTurnRequestedAt).not.toBeNull();
    expect(firstAssistantDeltaAt).not.toBeNull();
    const firstTokenMs = firstAssistantDeltaAt! - firstTurnRequestedAt!;
    expect(firstTokenMs).toBeLessThan(10_000);

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
      metadata: {
        toolCatalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        agentCheckpoint: expect.objectContaining({
          protocolVersion: AGENT_PROTOCOL_VERSION,
          threadId,
          toolCatalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          context: expect.objectContaining({ stage: "tool_catalog_ready" }),
        }),
        agentCheckpointHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(read.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "turn.started" }),
      expect.objectContaining({ name: "assistant.delta", output: expect.stringContaining("scripted turn") }),
      expect.objectContaining({ name: "turn.completed" }),
    ]));
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "turn/started",
        params: expect.objectContaining({ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      }),
      expect.objectContaining({
        method: "item/assistantDelta",
        params: expect.objectContaining({
          name: "assistant.delta",
          source: "provider",
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
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

    const compactionStartedAt = performance.now();
    const compactionResponse = await fetch(`${server.url}/v1/sessions/${encodeURIComponent(threadId)}/compact`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "manual", model: "openpond-scripted-chat-two-turns" }),
    });
    const compactionMs = performance.now() - compactionStartedAt;
    expect(compactionResponse.ok).toBe(true);
    expect(compactionResponse.headers.get("x-openpond-agent-transport")).toBe("transitional-http-adapter");
    await expect(compactionResponse.json()).resolves.toMatchObject({ ok: true, mode: "summary" });
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "compaction/started" }),
      expect.objectContaining({ method: "compaction/completed" }),
    ]));
    expect(compactionMs).toBeLessThan(10_000);
    reportMetric("firstTokenMs", firstTokenMs);
    reportMetric("compactionMs", compactionMs);
    unsubscribe?.();
  }, 20_000);

  test("interrupts a real in-flight provider turn through JSON-RPC", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-rpc-interrupt-"));
    let streamStarted!: () => void;
    const streamReady = new Promise<void>((resolve) => { streamStarted = resolve; });
    const server = await createOpenPondServer({
      port: 0,
      storeDir: directory,
      silent: true,
      streamOpenPondHostedChatTurn: async function* ({ signal }) {
        streamStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    cleanup.push({ close: server.close, directory, priorScriptedModels: undefined });
    const rpc = new AgentJsonRpcDispatcher(server.agentRuntime);
    await initializeRpc(rpc);
    const threadResponse = await rpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
          experience: "work",
          metadata: { workspaceTarget: "local" },
          title: "RPC interruption",
        },
      },
    });
    const threadId = resultRecord(threadResponse).thread.id as string;
    const pendingTurn = rpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: {
          prompt: "Keep running until interrupted.",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      },
    });
    await streamReady;
    const interruptedAt = performance.now();
    const interruptResponse = await rpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "turn/interrupt",
      params: { threadId, reason: "Phase 2 cancellation measurement" },
    });
    const interruptionMs = performance.now() - interruptedAt;
    expect(resultRecord(interruptResponse).turn).toMatchObject({ status: "interrupted" });
    expect(resultRecord(await pendingTurn).turn).toMatchObject({ status: "interrupted" });
    expect(interruptionMs).toBeLessThan(2_000);
    reportMetric("cancellationMs", interruptionMs);
  }, 20_000);

  test("recovers persisted threads and Harness selection after an app-server restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-rpc-restart-"));
    const priorScriptedModels = process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
    process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = "1";
    let activeServer: Awaited<ReturnType<typeof createOpenPondServer>> | null = null;
    cleanup.push({
      close: async () => { await activeServer?.close(); },
      directory,
      priorScriptedModels,
    });

    activeServer = await createOpenPondServer({ port: 0, storeDir: directory, silent: true, httpEnabled: false });
    const firstRpc = new AgentJsonRpcDispatcher(activeServer.agentRuntime);
    await initializeRpc(firstRpc);
    const threadResponse = await firstRpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-scripted-chat-two-turns" },
          experience: "work",
          metadata: { workspaceTarget: "local" },
          title: "RPC restart recovery",
        },
      },
    });
    const threadId = resultRecord(threadResponse).thread.id as string;
    await firstRpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: {
          prompt: "persist this turn across restart",
          modelRef: { providerId: "openpond", modelId: "openpond-scripted-chat-two-turns" },
        },
      },
    });
    const beforeRestart = resultRecord(await firstRpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "harness/validate",
      params: {},
    }));
    await activeServer.close();
    activeServer = null;

    const restartStartedAt = performance.now();
    activeServer = await createOpenPondServer({ port: 0, storeDir: directory, silent: true, httpEnabled: false });
    const restartMs = performance.now() - restartStartedAt;
    const restartedRpc = new AgentJsonRpcDispatcher(activeServer.agentRuntime);
    await initializeRpc(restartedRpc);
    const read = resultRecord(await restartedRpc.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "thread/resume",
      params: { threadId },
    }));
    const afterRestart = resultRecord(await restartedRpc.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "harness/validate",
      params: {},
    }));
    expect(read.turns).toHaveLength(1);
    expect(read.turns[0]).toMatchObject({ status: "completed", prompt: "persist this turn across restart" });
    expect(afterRestart.harnessRelease.contentHash).toBe(beforeRestart.harnessRelease.contentHash);
    expect(restartMs).toBeLessThan(10_000);
    reportMetric("restartRecoveryMs", restartMs);
  }, 30_000);
});

async function initializeRpc(rpc: AgentJsonRpcDispatcher): Promise<void> {
  await rpc.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      client: { name: "integration-test", version: "1" },
    },
  });
  await rpc.handle({ jsonrpc: "2.0", method: "initialized" });
}

function resultRecord(response: unknown): Record<string, any> {
  if (!response || typeof response !== "object" || !("result" in response)) {
    throw new Error(`Expected JSON-RPC success: ${JSON.stringify(response)}`);
  }
  return (response as { result: Record<string, any> }).result;
}

function reportMetric(name: string, value: number): void {
  if (process.env.OPENPOND_REPORT_AGENT_METRICS === "1") {
    console.info(`OPENPOND_AGENT_METRIC ${JSON.stringify({ name, value: Math.round(value * 100) / 100 })}`);
  }
}
