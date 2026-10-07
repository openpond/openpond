import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createEnclaveConnection, resolveUrlModel } from "../apps/server/src/enclave/connection";
import { withUrlModels } from "../apps/server/src/enclave/provider";
import { ProviderSettingsSchema } from "@openpond/contracts/providers";
import { streamOpenAiCompatibleChatCompletion } from "../apps/server/src/openpond/openai-compatible-provider";
import type { UrlModel } from "@openpond/contracts/enclave";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "url-models-test-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  let redirectedRequests = 0;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url?.startsWith("/redirect/")) { res.writeHead(302, { Location: `${origin}/leak` }); res.end(); return; }
    if (req.url === "/leak") { redirectedRequests++; json(200, { data: [{ id: "stolen" }] }); return; }
    if (req.url === "/tvc/health") { json(200, { status: "healthy", runtime: "openpond-app-server", inference: "embedded", model: "tiny-model", contextTokens: 4096, persistentHistory: false }); return; }
    if (req.url === "/tvc/chat") {
      if (req.headers.authorization !== "Bearer tvc-secret") { json(401, { error: "bad token" }); return; }
      if (!body?.prompt) { json(400, {}); return; }
      if (body.prompt === "wait") { res.once("close", cancelled); started(); return; }
      json(200, { requestId: "request", threadId: "thread", turnId: "turn", answer: body.prompt, tools: [] }); return;
    }
    if (req.url === "/openai/models") { json(200, { data: [{ id: "anonymous-model" }] }); return; }
    if (req.url === "/openai/chat/completions") {
      expect(req.headers.authorization).toBeUndefined(); expect(body.model).toBe("anonymous-model");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"from the endpoint"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No server address");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { home, origin, cancellation, start, leaked: () => redirectedRequests, service: createEnclaveConnection({ home }) };
}

// Failure story: adding a second endpoint must not overwrite, reveal or redirect
// the first endpoint's key; anonymous local models must remain usable.
test("URL model registration binds encrypted credentials to each endpoint and serves both protocols", async () => {
  const { home, origin, service, leaked } = await fixture();
  await expect(service("inspect", { endpoint: `${origin}/tvc`, token: "wrong" })).rejects.toMatchObject({ status: 401 });
  const first = await service("save", { endpoint: `${origin}/tvc`, token: "tvc-secret", model: "tiny-model", name: "Private model", providerName: "Hosted models" }) as { models: UrlModel[] };
  const tvc = first.models[0]!;
  const second = await service("save", { endpoint: `${origin}/openai`, model: "anonymous-model", name: "Local model", providerName: "Local models" }) as { models: UrlModel[] };
  expect(second.models).toHaveLength(2);
  expect(second.models.map((entry) => entry.providerName).sort()).toEqual(["Hosted models", "Local models"]);
  expect(JSON.stringify(second)).not.toContain("tvc-secret");
  expect(await readFile(path.join(home, "secrets/credentials.json"), "utf8")).not.toContain("tvc-secret");
  expect(await service("chat", { id: tvc.id, prompt: "A real turn" })).toMatchObject({ answer: "A real turn" });
  const anonymous = second.models.find((model) => model.protocol === "openai")!;
  const model = await resolveUrlModel(home, anonymous.id);
  const settings = await withUrlModels(home, ProviderSettingsSchema.parse({}));
  expect(settings.modelCaches["custom-openai-compatible"]?.models.map((entry) => entry.id)).toEqual(expect.arrayContaining([tvc.id, anonymous.id]));
  const chunks = [];
  for await (const chunk of streamOpenAiCompatibleChatCompletion({
    providerId: "custom-openai-compatible", settings, secrets: { version: 1, providers: {} },
    resolvedProvider: { providerId: "custom-openai-compatible", baseUrl: model.endpoint, model: model.model, auth: { type: "api_key", apiKey: model.token } },
    allowAnonymous: true, messages: [{ role: "user", content: "hello" }],
  })) chunks.push(chunk);
  expect(chunks.some((chunk) => chunk.type === "text_delta" && chunk.text === "from the endpoint")).toBe(true);
  await expect(service("inspect", { endpoint: `${origin}/redirect`, token: "tvc-secret" })).rejects.toMatchObject({ status: 502 });
  expect(leaked()).toBe(0);
});

// Failure story: a removed or cancelled TVC request must release the single
// inference slot, and an oversized prompt must never reach the remote model.
test("TVC cancellation releases the request and deleting a connection revokes future turns", async () => {
  const { origin, service, cancellation, start } = await fixture();
  const { models } = await service("save", { endpoint: `${origin}/tvc`, token: "tvc-secret", model: "tiny-model", name: "Private model", providerName: "Hosted models" }) as { models: UrlModel[] };
  const id = models[0]!.id;
  await expect(service("chat", { id, prompt: "é".repeat(513) })).rejects.toMatchObject({ status: 400 });
  const controller = new AbortController();
  const pending = service("chat", { id, prompt: "wait" }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ status: 408 });
  await start;
  await expect(service("chat", { id, prompt: "busy" })).rejects.toMatchObject({ status: 409 });
  controller.abort(); await rejected; await cancellation;
  expect(await service("chat", { id, prompt: "recovered" })).toMatchObject({ answer: "recovered" });
  await service("remove", { id });
  await expect(service("chat", { id, prompt: "revoked" })).rejects.toMatchObject({ status: 409 });
});
