import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { saveOpenPondAccount } from "@openpond/runtime";
import { withOpenPondHome } from "@openpond/persistence";
import { afterEach, expect, test, vi } from "vitest";
import { OpenPondAcpAgent } from "../apps/server/src/acp-agent";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SqliteStore } from "../apps/server/src/store/store";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

type Body = { messages: Array<{ role: string; content?: string; tool_call_id?: string }>; tools?: Array<{ function: { name: string; description: string } }> };
function chunk(response: ServerResponse, delta: unknown, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

async function fixture() {
  for (const key of ["OPENPOND_ACCOUNT", "OPENPOND_BASE_URL", "OPENPOND_API_URL", "OPENPOND_OPCHAT_API_URL", "OPENPOND_CHAT_API_URL"]) vi.stubEnv(key, "");
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-acp-boundary-")), home = path.join(root, "home"), cwd = path.join(root, "work");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/models")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data: [{ id: "openpond-chat" }, { id: "fixture-alternative" }] })); return; }
    if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
    const buffers = []; for await (const buffer of request) buffers.push(buffer);
    const body = JSON.parse(Buffer.concat(buffers).toString()) as Body;
    requests.push(body);
    response.setHeader("Content-Type", "text/event-stream");
    const latestUser = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content ?? "");
    const userIndex = body.messages.findLastIndex(message => message.role === "user");
    const toolDone = body.messages.slice(userIndex + 1).some(message => message.role === "tool");
    if (!toolDone && latestUser.includes("command proof")) {
      chunk(response, { tool_calls: [{ index: 0, id: "command-call", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ command: "printf approved > proof.txt", cwd }) } }] }, "tool_calls");
    } else if (!toolDone && latestUser.includes("MCP proof")) {
      const tool = body.tools?.find(tool => tool.function.description.includes("acp-fixture"));
      if (tool) chunk(response, { tool_calls: [{ index: 0, id: "mcp-call", type: "function", function: { name: tool.function.name, arguments: "{}" } }] }, "tool_calls");
      else chunk(response, { content: "no MCP tools" }, "stop");
    } else if (!toolDone && latestUser.includes("question proof")) {
      chunk(response, { tool_calls: [{ index: 0, id: "question-call", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Choose a colour", options: [{ id: "blue", label: "Blue" }], allowFreeform: true }) } }] }, "tool_calls");
    } else if (latestUser.includes("slow proof")) {
      chunk(response, { content: "started" });
      return; // Remains open until harness interruption closes the request.
    } else chunk(response, { content: "fixture answer" }, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
  await withOpenPondHome(home, () => saveOpenPondAccount({ apiKey: "opk_acp_fixture", handle: "fixture", apiBaseUrl: url, chatApiBaseUrl: url, baseUrl: url, setActive: true }));
  return { root, home, cwd, url, requests };
}

function connect(home: string, permission: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse> = async () => ({ outcome: { outcome: "selected", optionId: "allow" } }), elicitation?: (request: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>) {
  const input = new PassThrough(), output = new PassThrough();
  const agent = new OpenPondAcpAgent({ home, version: "test" });
  const server = agent.connect(acp.ndJsonStream(Writable.toWeb(output), Readable.toWeb(input) as ReadableStream<Uint8Array>));
  const updates: acp.SessionNotification[] = [];
  const app = acp.client().onNotification("session/update", ctx => { updates.push(ctx.params); }).onRequest("session/request_permission", ctx => permission(ctx.params));
  if (elicitation) app.onRequest("elicitation/create", ctx => elicitation(ctx.params));
  const client = app.connect(acp.ndJsonStream(Writable.toWeb(input), Readable.toWeb(output) as ReadableStream<Uint8Array>));
  const close = async () => { client.close(); server.close(); await agent.close(); input.destroy(); output.destroy(); };
  cleanup.push(close);
  const initialize = () => client.agent.request("initialize", { protocolVersion: 1, clientCapabilities: { auth: { terminal: true }, ...(elicitation ? { elicitation: { form: {} } } : {}) } });
  return { client: client.agent, updates, initialize, close };
}
const text = (prompt: string): acp.ContentBlock[] => [{ type: "text", text: prompt }];

// Durable history must survive a process replacement without leaking or rebinding
// another workspace/account's session, and the runtime home must have one writer.
test("ACP sessions persist, replay and reject concurrent ownership or changed scope", async () => {
  const f = await fixture(), first = connect(f.home);
  await first.initialize();
  const session = await first.client.request("session/new", { cwd: f.cwd, mcpServers: [] });
  const outcome = await first.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("hello") });
  expect(outcome.stopReason).toBe("end_turn");
  expect(first.updates.some(event => event.sessionId === session.sessionId && event.update.sessionUpdate === "agent_message_chunk")).toBe(true);
  const competing = connect(f.home); await competing.initialize();
  await expect(competing.client.request("session/new", { cwd: f.cwd, mcpServers: [] })).rejects.toThrow(/owns this home/);
  await competing.close(); await first.close();
  const resumed = connect(f.home); await resumed.initialize();
  await resumed.client.request("session/load", { sessionId: session.sessionId, cwd: f.cwd, mcpServers: [] });
  expect(resumed.updates.filter(event => event.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1);
  await resumed.client.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: "fixture-alternative" });
  await expect(resumed.client.request("session/load", { sessionId: session.sessionId, cwd: f.root, mcpServers: [] })).rejects.toThrow(/different ACP/);
  await withOpenPondHome(f.home, () => saveOpenPondAccount({ apiKey: "opk_second_fixture", handle: "different", apiBaseUrl: f.url, chatApiBaseUrl: f.url, baseUrl: f.url, setActive: true }));
  await expect(resumed.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("hello again") })).rejects.toThrow(/ownership changed/);
});

// A late permission answer must never execute a cancelled command. The prompt
// must settle even when the client's permission handler has not returned.
test("cancel settles pending permission, ignores late approval and blocks overlapping prompts", async () => {
  const f = await fixture();
  let received!: () => void, answer!: (result: acp.RequestPermissionResponse) => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const c = connect(f.home, async request => { expect(request.toolCall.toolCallId).toBe("command-call"); received(); return new Promise(resolve => { answer = resolve; }); });
  await c.initialize(); const session = await c.client.request("session/new", { cwd: f.cwd, mcpServers: [] });
  const pending = c.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("command proof") });
  await requested;
  expect(c.updates.some(event => event.update.sessionUpdate === "tool_call" && event.update.toolCallId === "command-call")).toBe(true);
  await expect(c.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("overlap") })).rejects.toThrow(/active prompt/);
  await c.client.notify("session/cancel", { sessionId: session.sessionId });
  expect((await pending).stopReason).toBe("cancelled");
  answer({ outcome: { outcome: "selected", optionId: "allow" } });
  await expect(readFile(path.join(f.cwd, "proof.txt"))).rejects.toThrow();
  expect((await c.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("hello after cancellation") })).stopReason).toBe("end_turn");
});

// HTTP integration credentials are session supplied, never durable config or
// part of another session's tool catalog.
test("HTTP MCP forwards supplied authorization without persisting the header", async () => {
  const f = await fixture(), c = connect(f.home);
  const mcp = new McpServer({ name: "http-fixture", version: "1" });
  mcp.registerTool("ping", { description: "acp-fixture HTTP ping", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "HTTP MCP boundary proof" }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await mcp.connect(transport);
  let authenticatedRequests = 0;
  let terminated = false;
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer acp-header-fixture") { response.writeHead(401).end(); return; }
    authenticatedRequests += 1;
    if (request.method === "DELETE") terminated = true;
    await transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { await mcp.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  await c.initialize();
  const session = await c.client.request("session/new", { cwd: f.cwd, mcpServers: [{ type: "http", name: "http-fixture", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, headers: [{ name: "Authorization", value: "Bearer acp-header-fixture" }] }] });
  await c.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("MCP proof") });
  expect(c.updates.some(event => event.update.sessionUpdate === "tool_call_update" && JSON.stringify(event.update).includes("HTTP MCP boundary proof"))).toBe(true);
  expect(authenticatedRequests).toBeGreaterThan(1);
  await c.close();
  expect(terminated).toBe(true);
  const store = new SqliteStore(f.home);
  try { expect(JSON.stringify(await store.getSession(session.sessionId))).not.toContain("acp-header-fixture"); }
  finally { await store.close(); }
});

// Supplied MCP commands must run only for their session, behind ACP permission,
// and their owned subprocess must exit when the connection closes.
test("MCP tools are scoped, permission controlled and cleaned up on disconnect", async () => {
  const f = await fixture(), c = connect(f.home);
  const require = createRequire(import.meta.url);
  const moduleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
  const transportUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
  const fixturePath = path.join(f.root, "mcp.mjs"), pidPath = path.join(f.root, "mcp.pid");
  await writeFile(fixturePath, `import { McpServer } from ${JSON.stringify(moduleUrl)}; import { StdioServerTransport } from ${JSON.stringify(transportUrl)}; import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); const server = new McpServer({ name: 'acp-fixture', version: '1' }); server.registerTool('ping', { description: 'acp-fixture ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'MCP boundary proof' }] })); await server.connect(new StdioServerTransport());`);
  await c.initialize();
  const descriptor: acp.McpServer = { name: "acp-fixture", command: process.execPath, args: [fixturePath], env: [] };
  const withMcp = await c.client.request("session/new", { cwd: f.cwd, mcpServers: [descriptor] });
  await c.client.request("session/prompt", { sessionId: withMcp.sessionId, prompt: text("MCP proof") });
  expect(c.updates.some(event => event.update.sessionUpdate === "tool_call_update" && JSON.stringify(event.update).includes("MCP boundary proof"))).toBe(true);
  const plain = await c.client.request("session/new", { cwd: f.cwd, mcpServers: [] });
  await c.client.request("session/prompt", { sessionId: plain.sessionId, prompt: text("MCP proof") });
  expect(f.requests.at(-1)?.tools?.some(tool => tool.function.description.includes("acp-fixture"))).toBe(false);
  await expect(c.client.request("session/load", { sessionId: withMcp.sessionId, cwd: f.cwd, mcpServers: [] })).rejects.toThrow(/different ACP/);
  const pid = Number(await readFile(pidPath, "utf8"));
  await c.close();
  expect(() => process.kill(pid, 0)).toThrow();
});

// An elicitation answer continues the same conversation through the existing
// durable question resolver; old clients can still answer in their next prompt.
test("questions use negotiated elicitation and continue the same session", async () => {
  const f = await fixture(), c = connect(f.home, undefined, async () => ({ action: "accept", content: { option: "blue", answer: "Blue please" } }));
  await c.initialize(); const session = await c.client.request("session/new", { cwd: f.cwd, mcpServers: [] });
  expect((await c.client.request("session/prompt", { sessionId: session.sessionId, prompt: text("question proof") })).stopReason).toBe("end_turn");
  expect(f.requests.some(request => request.messages.some(message => message.role === "user" && message.content?.includes("Blue please")))).toBe(true);
  await expect(c.client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "audio", data: "", mimeType: "audio/wav" }] })).rejects.toThrow(/Unsupported ACP content/);
});

// Images use the runtime artifact owner and survive history replay without
// reading arbitrary resource links from the client's filesystem.
test("image/context prompts materialize and replay through the existing attachment owner", async () => {
  const f = await fixture(), c = connect(f.home);
  await c.initialize();
  const session = await c.client.request("session/new", { cwd: f.cwd, mcpServers: [] });
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=" };
  await c.client.request("session/prompt", { sessionId: session.sessionId, prompt: [image, { type: "resource", resource: { uri: "fixture://context", text: "Embedded context" } }] });
  await c.close();
  const replay = connect(f.home); await replay.initialize();
  await replay.client.request("session/load", { sessionId: session.sessionId, cwd: f.cwd, mcpServers: [] });
  expect(replay.updates.some(event => event.update.sessionUpdate === "user_message_chunk" && event.update.content.type === "image" && event.update.content.data === image.data)).toBe(true);
  expect(replay.updates.some(event => event.update.sessionUpdate === "user_message_chunk" && event.update.content.type === "text" && event.update.content.text.includes("Embedded context"))).toBe(true);
});
