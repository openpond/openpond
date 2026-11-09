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
  let mode: "normal" | "reject" | "truncated" | "held" = "normal";
  let calls = 0;
  let cancelled = false;
  const server = createServer(async (req, res) => {
    calls++;
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
      headers: { authorization: "Bearer attempted-override", "x-openpond-team-id": "wrong-team" },
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
});
