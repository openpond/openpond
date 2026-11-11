import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { z } from "zod";
import { generateText, streamText } from "ai";
import { createOpenPondClient, ProductModelError } from "../src/index";
import { toAIModel } from "../src/ai-sdk";

const PrivateWire = z.fromJSONSchema(
  JSON.parse(
    readFileSync(
      new URL("../fixtures/personalized-inference-request.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

// Protect the paid-call boundary: exact personalized routing, no silent replay,
// complete stream evidence, and cancellation when a consumer stops reading.
test("named models and AI SDK consumer preserve exact routing, usage and no-replay semantics", async () => {
  type FixtureMode = "normal" | "reject" | "truncated" | "held" | "pending" | "pending-tools"
    | "pending-mismatch" | "pending-abort" | "pending-throttled" | "lost" | "lost-tools";
  let mode: FixtureMode = "normal";
  type Operation = { id: string; clientId: string; model: string; deadlineAt: string;
    mode: FixtureMode; reads: number };
  const operations = new Map<string, Operation>();
  let paidPosts = 0;
  let statusReads = 0;
  let observationAbort: AbortController | undefined;
  const retainedCompletion = (operation: Operation) => ({
    id: operation.id, model: operation.model, system_fingerprint: "version-evidence",
    openpond: { weightReceipt: { versionHash: "exact-version" } },
    choices: [{ index: 0, message: ["pending-tools", "lost-tools"].includes(operation.mode)
      ? { role: "assistant", content: null, tool_calls: [{ id: "call-fixture", type: "function",
        function: { name: "lookup", arguments: '{"value":"ok"}' } }] }
      : { role: "assistant", content: "retained hello" },
      finish_reason: ["pending-tools", "lost-tools"].includes(operation.mode) ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
  const retainedStatus = (operation: Operation, completed: boolean) => ({
    schemaVersion: "openpond.modelRequestStatus.v1", requestId: operation.id,
    clientRequestId: operation.mode === "pending-mismatch" && operation.reads > 0 ? crypto.randomUUID() : operation.clientId,
    modelId: operation.model, state: completed ? "completed" : "pending",
    deadlineAt: operation.deadlineAt, retryAt: completed ? null : new Date().toISOString(),
    result: completed ? retainedCompletion(operation) : null, failureCode: null,
  });
  let calls = 0;
  let cancelled = false;
  const server = createServer(async (req, res) => {
    calls++;
    if (req.method === "GET") {
      statusReads++;
      const url = new URL(req.url!, "http://fixture.invalid");
      const operation = url.searchParams.has("clientRequestId")
        ? [...operations.values()].find(value => value.clientId === url.searchParams.get("clientRequestId"))
        : operations.get(url.pathname.split("/").at(-1)!);
      expect(operation).toBeDefined();
      if (!operation) { res.writeHead(404); res.end(); return; }
      expect(req.headers.authorization).toBe("Bearer serving-key");
      expect(req.headers["x-openpond-team-id"]).toBe("team-one");
      expect(url.pathname.startsWith("/personalized/v1/chat/completions")).toBe(true);
      operation.reads++;
      if (operation.mode === "pending-throttled" && operation.reads === 1) {
        res.writeHead(429, { "Retry-After": "1" });
        res.end("{}");
        return;
      }
      if (operation.mode === "pending-abort") observationAbort?.abort();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(retainedStatus(operation, operation.mode.startsWith("lost") || operation.reads >= 2)));
      return;
    }
    paidPosts++;
    expect(req.method).toBe("POST");
    expect(req.headers["openpond-api-key"]).toBeUndefined();
    expect(z.uuid().safeParse(req.headers["x-openpond-client-request-id"]).success).toBe(true);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!PrivateWire.safeParse(body).success) {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    expect(req.headers["x-openpond-team-id"]).toBe(
      body.model === "saved-model-two" ? "team-two" : "team-one",
    );
    res.setHeader("x-openpond-request-id", "header-request-one");
    expect(req.url).toBe("/personalized/v1/chat/completions");
    expect(req.headers.authorization).toBe(
      body.model === "saved-model-two" ? "Bearer other-key" : "Bearer serving-key",
    );
    expect(["saved-model-one", "saved-model-two"]).toContain(body.model);
    if (mode.startsWith("pending") || mode.startsWith("lost")) {
      const operation: Operation = { id: `pinf_${crypto.randomUUID()}`,
        clientId: String(req.headers["x-openpond-client-request-id"]), model: body.model,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(), mode, reads: 0 };
      operations.set(operation.id, operation);
      if (mode.startsWith("lost")) { req.socket.destroy(); return; }
      res.setHeader("x-openpond-request-id", operation.id);
      // The transport must derive its GET destination; never follow Location.
      res.setHeader("Location", "https://untrusted.invalid/collect");
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify(retainedStatus(operation, false)));
      return;
    }
    if (mode === "reject") {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    const identity = {
      id: "request-one",
      model: "resolved-version-one",
      system_fingerprint: "version-evidence",
      openpond: { weightReceipt: { versionHash: "exact-version" } },
    };
    const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
    if (!body.stream) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ...identity,
          choices: [
            { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
      return;
    }
    expect(body.stream_options).toBeUndefined();
    res.setHeader("Content-Type", "text/event-stream");
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
    emit({
      ...identity,
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    });
    if (mode === "held") {
      const interval = setInterval(() => res.write(": keepalive\r\n\r\n"), 10);
      res.on("close", () => {
        clearInterval(interval);
        cancelled = true;
      });
      return;
    }
    if (mode === "truncated") {
      res.end();
      return;
    }
    emit({ ...identity, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    emit({ ...identity, choices: [], usage });
    res.write("data: [DONE]\r\n\r\n");
    res.on("close", () => {
      cancelled = true;
    });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  try {
    const client = createOpenPondClient({
      apiKey: "workspace-key",
      teamId: "team-one",
      serving: {
        baseUrl: `http://127.0.0.1:${address.port}/personalized/v1`,
        apiKey: "serving-key",
      },
      models: { support: "saved-model-one" },
    });
    const answer = await client.models.support.generate({ prompt: "hi" });
    expect(answer).toMatchObject({
      text: "hello",
      requestId: "header-request-one",
      evidence: { weightReceipt: { versionHash: "exact-version" } },
      modelId: "saved-model-one",
      resolvedModelId: "resolved-version-one",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    const events = await collect(client.models.support.stream({ prompt: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "finish", result: answer });
    const aiModel = toAIModel(client.models.support);
    const aiAnswer = await generateText({
      model: aiModel,
      prompt: "hi",
      headers: { authorization: "Bearer attempted-override", "openpond-api-key": "attempted-override", "x-openpond-team-id": "wrong-team" },
    });
    expect(aiAnswer.text).toBe("hello");
    expect(aiAnswer.providerMetadata?.openpond).toEqual({
      weightReceipt: { versionHash: "exact-version" },
    });
    const beforeOverride = calls;
    await expect(
      generateText({
        model: aiModel,
        prompt: "hi",
        providerOptions: { openpond: { model: "saved-model-two" } },
      }),
    ).rejects.toMatchObject({ code: "model_override_forbidden", outcomeUnknown: false });
    expect(calls).toBe(beforeOverride);
    await expect(
      generateText({
        model: aiModel,
        prompt: "hi",
        providerOptions: { openpond: { stream: true } },
      }),
    ).rejects.toMatchObject({ code: "transport_override_forbidden", outcomeUnknown: false });
    expect(calls).toBe(beforeOverride);
    const stream = streamText({ model: aiModel, prompt: "hi" });
    expect(await stream.text).toBe("hello");
    expect(await stream.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    expect(cancelled).toBe(true);
    const other = createOpenPondClient({
      apiKey: "other-workspace-key",
      teamId: "team-two",
      serving: { baseUrl: `http://127.0.0.1:${address.port}/personalized/v1`, apiKey: "other-key" },
      models: { support: "saved-model-two" },
    });
    expect((await other.models.support.generate({ prompt: "hi" })).modelId).toBe("saved-model-two");
    mode = "held";
    cancelled = false;
    for await (const event of client.models.support.stream({ prompt: "hi" })) {
      expect(event.type).toBe("text");
      break;
    }
    for (let attempt = 0; !cancelled && attempt < 20; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
    mode = "truncated";
    await expect(collect(client.models.support.stream({ prompt: "hi" }))).rejects.toMatchObject({
      code: "model_stream_interrupted",
      outcomeUnknown: true,
    });
    const incomplete = streamText({
      model: aiModel,
      prompt: "hi",
      onError: () => {},
    });
    await expect(collect(incomplete.fullStream)).rejects.toMatchObject({
      code: "model_stream_interrupted",
      outcomeUnknown: true,
    });
    mode = "reject";
    const before = calls;
    await expect(generateText({ model: aiModel, prompt: "hi" })).rejects.toBeInstanceOf(
      ProductModelError,
    );
    expect(calls).toBe(before + 1);
    await expect(
      generateText({
        model: aiModel,
        prompt: "hi",
        tools: {
          tool: {
            description: "not allowed",
            inputSchema: z.object({}),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "tools_unsupported" });
    expect(calls).toBe(before + 1);
    // An accepted request is not an OpenAI completion. Both consumers must
    // observe the same retained operation, including tools and interrupted reads.
    const beforePending = paidPosts;
    const beforeReads = statusReads;
    mode = "pending";
    expect((await client.models.support.generate({ prompt: "pending" })).text).toBe("retained hello");
    expect((await collect(client.models.support.stream({ prompt: "pending" }))).at(-1)).toMatchObject({
      type: "finish", result: { text: "retained hello", usage: { totalTokens: 5 } },
    });
    const pendingAnswer = await generateText({ model: aiModel, prompt: "pending" });
    expect(pendingAnswer.text).toBe("retained hello");
    expect(pendingAnswer.providerMetadata?.openpond).toEqual({ weightReceipt: { versionHash: "exact-version" } });
    const pendingStream = streamText({ model: aiModel, prompt: "pending" });
    expect(await pendingStream.text).toBe("retained hello");
    expect(await pendingStream.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    expect(paidPosts).toBe(beforePending + 4);
    expect(statusReads).toBe(beforeReads + 8);

    // Real HTTP throttling must delay only authenticated status reads. A new
    // paid POST here would duplicate the accepted operation and its exposure.
    mode = "pending-throttled";
    const beforeThrottlePosts = paidPosts, beforeThrottleReads = statusReads;
    expect((await client.models.support.generate({ prompt: "retained throttled result" })).text).toBe("retained hello");
    expect(paidPosts).toBe(beforeThrottlePosts + 1);
    expect(statusReads).toBe(beforeThrottleReads + 2);

    const toolClient = createOpenPondClient({ apiKey: "serving-key", teamId: "team-one",
      serving: { baseUrl: `http://127.0.0.1:${address.port}/personalized/v1` },
      models: { support: { id: "saved-model-one", capabilities: { tools: true } } } });
    const tools = { lookup: { description: "Read a fixture value", inputSchema: z.object({ value: z.string() }) } };
    mode = "pending-tools";
    const beforeTools = paidPosts;
    const toolAnswer = await generateText({ model: toAIModel(toolClient.models.support), prompt: "lookup", tools });
    expect(toolAnswer.toolCalls[0]).toMatchObject({ toolCallId: "call-fixture", toolName: "lookup", input: { value: "ok" } });
    const toolStream = streamText({ model: toAIModel(toolClient.models.support), prompt: "lookup", tools });
    expect((await toolStream.toolCalls)[0]).toMatchObject({ toolCallId: "call-fixture", toolName: "lookup", input: { value: "ok" } });
    expect(paidPosts).toBe(beforeTools + 2);

    mode = "pending-mismatch";
    const beforeMismatch = paidPosts;
    await expect(generateText({ model: aiModel, prompt: "changed identity" })).rejects.toMatchObject({
      code: "model_recovery_identity_changed", outcomeUnknown: true,
    });
    expect(paidPosts).toBe(beforeMismatch + 1);

    mode = "pending-abort";
    observationAbort = new AbortController();
    const beforeAbort = paidPosts;
    let interrupted: unknown;
    try { await generateText({ model: aiModel, prompt: "cancel observation", abortSignal: observationAbort.signal }); }
    catch (error) { interrupted = error; }
    expect(interrupted).toBeInstanceOf(ProductModelError);
    expect(interrupted).toMatchObject({ outcomeUnknown: true,
      requestId: expect.stringMatching(/^pinf_/), clientRequestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(paidPosts).toBe(beforeAbort + 1);

    mode = "lost";
    const beforeLost = paidPosts;
    let lost: unknown;
    try { await generateText({ model: aiModel, prompt: "lost initial response" }); }
    catch (error) { lost = error; }
    expect(lost).toBeInstanceOf(ProductModelError);
    expect(lost).toMatchObject({ outcomeUnknown: true, clientRequestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(paidPosts).toBe(beforeLost + 1);
    if (!(lost instanceof ProductModelError) || !lost.clientRequestId) throw new Error("Missing recovery identity");
    expect(await client.models.support.recover(lost.clientRequestId)).toMatchObject({
      state: "completed", result: { text: "retained hello" },
    });
    expect(paidPosts).toBe(beforeLost + 1);
    mode = "lost-tools";
    const beforeLostTools = paidPosts;
    let lostTools: unknown;
    try { await generateText({ model: toAIModel(toolClient.models.support), prompt: "lost tool response", tools }); }
    catch (error) { lostTools = error; }
    expect(lostTools).toBeInstanceOf(ProductModelError);
    if (!(lostTools instanceof ProductModelError) || !lostTools.clientRequestId) throw new Error("Missing tool recovery identity");
    const recoveredTools = await toolClient.models.support.recover(lostTools.clientRequestId);
    expect(recoveredTools).toMatchObject({ state: "completed", result: { text: "", toolCalls: [{
      id: "call-fixture", type: "function", function: { name: "lookup", arguments: '{"value":"ok"}' },
    }] } });
    expect(await toolClient.models.support.inspectRequest(recoveredTools.requestId)).toEqual(recoveredTools);
    await expect(client.models.support.recover(lostTools.clientRequestId)).rejects.toMatchObject({ code: "model_response_invalid" });
    expect(paidPosts).toBe(beforeLostTools + 1);
    // Exercise the documented key-only setup through the same HTTP consumer.
    // Assert the production destination before forwarding to the local listener.
    mode = "normal";
    const productionDefault = createOpenPondClient({
      apiKey: "serving-key", teamId: "team-one",
      models: { support: "saved-model-one" },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.openpond.ai/v1/chat/completions");
        return fetch(`http://127.0.0.1:${address.port}/personalized/v1/chat/completions`, init);
      },
    });
    expect((await productionDefault.models.support.generate({ prompt: "hi" })).text).toBe("hello");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
