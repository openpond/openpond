import { PassThrough } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  AGENT_PROTOCOL_VERSION,
  AgentHostStorageClient,
  AgentJsonRpcDispatcher,
  AgentRpcClient,
  HostStorageRequestSchema,
  HOST_STORAGE_CONTRACT_VERSION,
  runAgentJsonlServer,
  type AgentRuntimeHost,
  type JsonRpcNotification,
} from "../src/index.js";

function host(): AgentRuntimeHost {
  return {
    capabilities: vi.fn(async () => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      placement: "local",
      methods: ["initialize", "initialized", "runtime/capabilities", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt", "approval/resolve", "userInput/resolve", "harness/inspect", "harness/proposalReview", "harness/review", "harness/acceptEvaluationReview", "harness/materializeEvaluationTaskset", "harness/runEvaluationBaseline", "harness/validate", "harness/backgroundReview", "harness/diff", "harness/rollback"],
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
    profileEvaluationPrepare: vi.fn(async (params) => ({ manifest: params })),
    profileEvaluationRun: vi.fn(async (params) => ({ run: params })),
    harnessInspect: vi.fn(async () => ({ release: "r1" })),
    harnessProposalReview: vi.fn(async (params) => ({ proposalReview: params })),
    harnessReview: vi.fn(async (params) => ({ review: params })),
    harnessAcceptEvaluationReview: vi.fn(async (params) => ({ acceptedEvaluationReview: params })),
    harnessMaterializeEvaluationTaskset: vi.fn(async (params) => ({ materializedEvaluationTaskset: params })),
    harnessRunEvaluationBaseline: vi.fn(async (params) => ({ evaluationBaseline: params })),
    harnessValidate: vi.fn(async () => ({ valid: true })),
    harnessBackgroundReview: vi.fn(async (params) => ({ backgroundReview: params })),
    harnessDiff: vi.fn(async (params) => ({ diff: params })),
    harnessRollback: vi.fn(async (params) => ({ rollback: params })),
  };
}

describe("agent JSON-RPC protocol", () => {
  // Failure story: a compute child must not choose its source/account, and an
  // admitted large environment state must not relax ordinary storage limits.
  test("bounds and isolates the admitted Experiment environment transport", async () => {
    const request = { contractVersion: 1 as const, requestId: "environment-case-0",
      operation: "experiment/environment" as const,
      params: { caseId: "case-1", admissionHash: "a".repeat(64), definitionHash: "b".repeat(64),
        ordinal: 0, operation: "create" as const, value: { input: {} }, timeoutMs: 1000 } };
    for (const forged of [{ source: "export function create() {}" }, { sandboxId: "other" }, { teamId: "other" }]) {
      expect(HostStorageRequestSchema.safeParse({ ...request, params: { ...request.params, ...forged } }).success).toBe(false);
    }
    const client = new AgentHostStorageClient();
    client.bind(async message => {
      client.accept({ jsonrpc: "2.0", id: message.id,
        result: { state: { text: "x".repeat(1_048_576) }, observation: {} } });
    });
    await expect(client.request(request)).resolves.toMatchObject({ observation: {} });
    await expect(client.request({ contractVersion: 1, requestId: "ordinary-storage",
      operation: "settings/get", params: {} })).rejects.toThrow("response is too large");
    client.close();
  });
  test("admits the bounded continuation filter on event pages", () => {
    const request = { contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: "continuation-page-1", operation: "events/page",
      params: { sessionId: "thread-1", afterSequence: 0, limit: 200,
        excludeReasoningDeltas: true } };
    expect(HostStorageRequestSchema.safeParse(request).success).toBe(true);
    expect(HostStorageRequestSchema.safeParse({ ...request,
      params: { ...request.params, excludeReasoningDeltas: "true" } }).success).toBe(false);
  });

  test("task inbox host requests reject forged scope and stale mutation revisions", () => {
    const request = {
      contractVersion: 1, requestId: "mutation-1", operation: "task-inbox/execute",
      params: { action: "mutateTaskInput", sessionId: "session-1", inputId: "input-1",
        change: { action: "cancel", expectedRevision: 2 } },
    };
    expect(HostStorageRequestSchema.safeParse(request).success).toBe(true);
    expect(HostStorageRequestSchema.safeParse({ ...request, params: { ...request.params, teamId: "forged" } }).success).toBe(false);
    expect(HostStorageRequestSchema.safeParse({ ...request, params: { ...request.params,
      change: { action: "cancel", expectedRevision: 0 } } }).success).toBe(false);
  });

  test("routes authoritative Profile evaluation preparation and run requests", async () => {
    const runtimeHost = host();
    const dispatcher = new AgentJsonRpcDispatcher(runtimeHost);
    await dispatcher.handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: AGENT_PROTOCOL_VERSION, client: { name: "test", version: "1" } },
    });
    await dispatcher.handle({ jsonrpc: "2.0", method: "initialized" });
    const request = { definitionId: "workflow-check", modelRef: { providerId: "openpond", modelId: "test" } };
    await expect(dispatcher.handle({ jsonrpc: "2.0", id: 2, method: "profile/evaluations/prepare", params: request }))
      .resolves.toMatchObject({ result: { manifest: request } });
    await expect(dispatcher.handle({ jsonrpc: "2.0", id: 3, method: "profile/evaluations/run", params: request }))
      .resolves.toMatchObject({ result: { run: request } });
    expect(runtimeHost.profileEvaluationPrepare).toHaveBeenCalledWith(request);
    expect(runtimeHost.profileEvaluationRun).toHaveBeenCalledWith(request);
  });

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

  test("delegates Harness proposal review through the private runtime", async () => {
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
    const review = {
      workspaceId: "personal-default",
      proposal: { id: "proposal-1", contentHash: "a".repeat(64) },
      decision: "approve",
    };
    await expect(
      dispatcher.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "harness/proposalReview",
        params: review,
      }),
    ).resolves.toMatchObject({ result: { proposalReview: review } });
    expect(runtimeHost.harnessProposalReview).toHaveBeenCalledWith(review);
  });

  test("delegates Harness evaluation review acceptance through the private runtime", async () => {
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
    const acceptance = {
      workspaceId: "personal-default",
      reviewRef: { id: "review-1", contentHash: "a".repeat(64) },
    };
    await expect(
      dispatcher.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "harness/acceptEvaluationReview",
        params: acceptance,
      }),
    ).resolves.toMatchObject({ result: { acceptedEvaluationReview: acceptance } });
    expect(runtimeHost.harnessAcceptEvaluationReview).toHaveBeenCalledWith(acceptance);
  });

  test("delegates reviewed Taskset materialization through the private runtime", async () => {
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
    const materialization = { creationId: "task_creation_1" };
    await expect(
      dispatcher.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "harness/materializeEvaluationTaskset",
        params: materialization,
      }),
    ).resolves.toMatchObject({ result: { materializedEvaluationTaskset: materialization } });
    expect(runtimeHost.harnessMaterializeEvaluationTaskset).toHaveBeenCalledWith(materialization);
  });

  test("delegates Harness baseline Evaluation through the private runtime", async () => {
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
    const baseline = {
      workspaceId: "personal-default",
      tasksetId: "taskset-1",
      reviewRef: { id: "review-1", contentHash: "a".repeat(64) },
      model: { providerId: "openpond", modelId: "openpond-chat" },
      maximumCostUsd: 0.1,
    };
    await expect(
      dispatcher.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "harness/runEvaluationBaseline",
        params: baseline,
      }),
    ).resolves.toMatchObject({ result: { evaluationBaseline: baseline } });
    expect(runtimeHost.harnessRunEvaluationBaseline).toHaveBeenCalledWith(baseline);
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

  test("services a correlated host storage response while turn/start is pending", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const client = new AgentHostStorageClient();
    const runtimeHost = host();
    runtimeHost.turnStart = vi.fn(async () => ({
      storage: await client.request({
        contractVersion: 1,
        requestId: "history-read-1",
        operation: "events/page",
        params: { sessionId: "thread-1", afterSequence: 0, limit: 10 },
      }),
    }));
    const output: Record<string, unknown>[] = [];
    let buffer = "";
    writable.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        output.push(message);
        if (message.method === "host/storage") {
          readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { entries: [] } })}\n`);
          readable.end();
        }
      }
    });
    const server = runAgentJsonlServer({ host: runtimeHost, readable, writable, hostStorageClient: client });
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: AGENT_PROTOCOL_VERSION, client: { name: "storage-test", version: "1" } } })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "thread-1" } })}\n`);
    await server;
    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "host/storage" }),
      expect.objectContaining({ id: 2, result: { storage: { entries: [] } } }),
    ]));
  });

  test("does not cut off an explicitly budgeted hosted sandbox create at 60 seconds", async () => {
    const client = new AgentHostStorageClient();
    client.bind(async () => {});
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const pending = client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: "cold-sandbox-create",
        operation: "sandbox/request",
        params: { action: { type: "create", payload: {} } },
      }, 300_000).catch((error: unknown) => error);
      expect(timer.mock.calls.at(-1)?.[1]).toBe(300_000);
      client.close();
      expect(await pending).toMatchObject({ message: "Host storage transport closed." });
    } finally {
      timer.mockRestore();
    }
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

  test("serves host storage replies while an async runtime is still starting", async () => {
    const client = new AgentHostStorageClient();
    const readable = new PassThrough();
    const writable = new PassThrough();
    const output: Record<string, unknown>[] = [];
    let buffer = "";
    writable.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        output.push(message);
        if (message.method === "host/storage") {
          readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ready: true } })}\n`);
        }
        if (message.id === 1) readable.end();
      }
    });
    const server = runAgentJsonlServer({
      host: async () => {
        const result = await client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
          requestId: "bootstrap", operation: "capabilities", params: {} });
        if (!result || typeof result !== "object" || (result as { ready?: boolean }).ready !== true) {
          throw new Error("Host storage did not admit startup.");
        }
        return host();
      },
      readable, writable, hostStorageClient: client,
    });
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: AGENT_PROTOCOL_VERSION, client: { name: "startup-test", version: "1" },
    } })}\n`);
    await server;
    expect(output.findIndex((message) => message.method === "host/storage")).toBeLessThan(
      output.findIndex((message) => message.id === 1),
    );
    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ id: 1, result: expect.anything() })]));
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
