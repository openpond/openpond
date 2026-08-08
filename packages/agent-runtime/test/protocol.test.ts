import { PassThrough } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  AGENT_PROTOCOL_VERSION,
  AgentJsonRpcDispatcher,
  AgentRpcClient,
  runAgentJsonlServer,
  type AgentRuntimeHost,
  type JsonRpcNotification,
} from "../src/index.js";

function host(): AgentRuntimeHost {
  return {
    capabilities: vi.fn(async () => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      placement: "local",
      methods: ["initialize", "initialized", "runtime/capabilities", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt", "approval/resolve", "userInput/resolve", "harness/inspect", "harness/review", "harness/validate"],
      features: { streamingEvents: true },
      tools: [],
      toolCatalogHash: "0".repeat(64),
    })),
    threadStart: vi.fn(async (params) => ({ thread: params })),
    threadResume: vi.fn(async (params) => ({ resumed: params })),
    threadRead: vi.fn(async (params) => ({ read: params })),
    turnStart: vi.fn(async (params) => ({ turn: params })),
    turnSteer: vi.fn(async (params) => ({ steer: params })),
    turnInterrupt: vi.fn(async (params) => ({ interrupted: params })),
    approvalResolve: vi.fn(async (params) => ({ approval: params })),
    userInputResolve: vi.fn(async (params) => ({ input: params })),
    harnessInspect: vi.fn(async () => ({ release: "r1" })),
    harnessReview: vi.fn(async (params) => ({ review: params })),
    harnessValidate: vi.fn(async () => ({ valid: true })),
  };
}

describe("agent JSON-RPC protocol", () => {
  test("uses the generated client for initialization and lifecycle calls", async () => {
    const request = vi.fn(async (method: string) => ({ method }));
    const notify = vi.fn(async () => undefined);
    const client = new AgentRpcClient({ request, notify });
    await expect(client.initialize({ name: "generated-client-test", version: "1" })).resolves.toEqual({
      method: "initialize",
    });
    await client.threadRead({ threadId: "thread-1" });
    expect(request).toHaveBeenNthCalledWith(1, "initialize", {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      client: { name: "generated-client-test", version: "1" },
      capabilities: {},
    });
    expect(notify).toHaveBeenCalledWith("initialized");
    expect(request).toHaveBeenNthCalledWith(2, "thread/read", { threadId: "thread-1" });
  });

  test("requires a compatible initialization handshake", async () => {
    const dispatcher = new AgentJsonRpcDispatcher(host());
    await expect(dispatcher.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "old", client: { name: "test", version: "1" } },
    })).resolves.toMatchObject({ error: { code: -32001 } });
    await expect(dispatcher.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {},
    })).resolves.toMatchObject({ error: { code: -32002 } });
  });

  test("delegates lifecycle methods only after initialized", async () => {
    const runtimeHost = host();
    const dispatcher = new AgentJsonRpcDispatcher(runtimeHost);
    await dispatcher.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        client: { name: "test", version: "1" },
      },
    });
    await dispatcher.handle({ jsonrpc: "2.0", method: "initialized" });
    const response = await dispatcher.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: { experience: "work" },
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { thread: { experience: "work" } },
    });
    expect(runtimeHost.threadStart).toHaveBeenCalledWith({ experience: "work" });
  });

  test("processes turn and interrupt requests concurrently over JSONL", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    let releaseTurn!: () => void;
    const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const runtimeHost = host();
    runtimeHost.turnStart = vi.fn(async () => {
      await turnReleased;
      return { status: "completed" };
    });
    runtimeHost.turnInterrupt = vi.fn(async () => {
      releaseTurn();
      return { status: "interrupted" };
    });
    const output: string[] = [];
    writable.on("data", (chunk) => output.push(chunk.toString()));
    const server = runAgentJsonlServer({ host: runtimeHost, readable, writable });
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: AGENT_PROTOCOL_VERSION, client: { name: "test", version: "1" } } })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "t" } })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/interrupt", params: { threadId: "t" } })}\n`);
    readable.end();
    await server;
    const messages = output.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 2, result: { status: "completed" } }),
      expect.objectContaining({ id: 3, result: { status: "interrupted" } }),
    ]));
  });

  test("forwards canonical host notifications", async () => {
    const listeners = new Set<(notification: JsonRpcNotification) => void>();
    const runtimeHost = host();
    runtimeHost.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const readable = new PassThrough();
    const writable = new PassThrough();
    const output: string[] = [];
    writable.on("data", (chunk) => output.push(chunk.toString()));
    const server = runAgentJsonlServer({ host: runtimeHost, readable, writable });
    for (const listener of listeners) listener({
      jsonrpc: "2.0",
      method: "turn/event",
      params: { name: "assistant.delta", output: "hello" },
    });
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: AGENT_PROTOCOL_VERSION, client: { name: "notification-test", version: "1" } } })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    readable.end();
    await server;
    expect(output.join("")).toContain('"method":"turn/event"');
  });

  test("buffers pre-initialization events and streams a bounded event burst with backpressure", async () => {
    let emit!: (notification: JsonRpcNotification) => void;
    const runtimeHost = host();
    runtimeHost.subscribe = (listener) => {
      emit = listener;
      return () => undefined;
    };
    const readable = new PassThrough();
    const writable = new PassThrough();
    const output: string[] = [];
    writable.on("data", (chunk) => output.push(chunk.toString()));
    const server = runAgentJsonlServer({ host: runtimeHost, readable, writable });
    const eventCount = 500;
    const startedAt = performance.now();
    for (let index = 0; index < eventCount; index += 1) {
      emit({
        jsonrpc: "2.0",
        method: "item/assistantDelta",
        params: { sequence: index, output: "x" },
      });
    }
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: AGENT_PROTOCOL_VERSION, client: { name: "throughput-test", version: "1" } } })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    readable.end();
    await server;
    const throughputMs = performance.now() - startedAt;
    const messages = output.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.filter((message) => message.method === "item/assistantDelta")).toHaveLength(eventCount);
    expect(messages.findIndex((message) => message.method === "item/assistantDelta")).toBeGreaterThan(
      messages.findIndex((message) => message.id === 1),
    );
    expect(throughputMs).toBeLessThan(2_000);
    if (process.env.OPENPOND_REPORT_AGENT_METRICS === "1") {
      console.info(`OPENPOND_AGENT_METRIC ${JSON.stringify({
        name: "eventThroughputPerSecond",
        value: Math.round((eventCount / throughputMs) * 100_000) / 100,
        eventCount,
        durationMs: Math.round(throughputMs * 100) / 100,
      })}`);
    }
  });
});
