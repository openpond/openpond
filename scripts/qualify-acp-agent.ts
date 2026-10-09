import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { AcpClient } from "@openpond/agent-runtime/acp/client";

// Qualify the packaged executable with independent protocol implementations.
// Only the HTTP model response is scripted; auth, harness, tools, storage and
// transport are production code. No credentials from the user's home are read.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.OPENPOND_ACP_EXECUTABLE ?? path.join(repo, "apps/cli/dist/cli.js");
const root = await mkdtemp(path.join(os.tmpdir(), "openpond-acp-qualification-"));
const home = path.join(root, "home"), cwd = path.join(root, "workspace");
await mkdir(cwd);
const server = createServer(async (request, response) => {
  if (request.url?.endsWith("/models")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data: [{ id: "openpond-chat" }] })); return; }
  if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
  const buffers: Buffer[] = []; for await (const buffer of request) buffers.push(buffer);
  const body = JSON.parse(Buffer.concat(buffers).toString()) as { messages: Array<{ role: string; content: string }> };
  response.setHeader("Content-Type", "text/event-stream");
  const latest = body.messages.findLast(message => message.role === "user")?.content ?? "";
  const lastUser = body.messages.findLastIndex(message => message.role === "user");
  const toolDone = body.messages.slice(lastUser + 1).some(message => message.role === "tool");
  const tool = latest.includes("plan proof") ? { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Qualify ACP", status: "completed" }] }) } : latest.includes("command proof") ? { name: "exec_command", arguments: JSON.stringify({ command: "printf 'ACP tool proof'" }) } : null;
  const delta = !toolDone && tool ? { tool_calls: [{ index: 0, id: "qualification-call", type: "function", function: tool }] } : { content: "ACP packaged harness proof" };
  response.write(`data: ${JSON.stringify({ id: "qualification", choices: [{ index: 0, delta, finish_reason: latest.includes("slow proof") ? null : "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\n`);
  if (!latest.includes("slow proof")) response.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const env = { ...process.env, OPENPOND_HOME: home, OPENPOND_ACCOUNT: "", OPENPOND_BASE_URL: "", OPENPOND_API_URL: `http://127.0.0.1:${port}`, OPENPOND_OPCHAT_API_URL: `http://127.0.0.1:${port}`, OPENPOND_CHAT_API_URL: "" };
const args = [executable, "acp", "--home", home];
const reportPath = process.env.OPENPOND_ACP_REPORT ?? path.join(repo, "tmp/acp-agent-qualification/report.json");
await mkdir(path.dirname(reportPath), { recursive: true });
const report: Record<string, unknown> = { platform: `${process.platform}/${process.arch}`, node: process.version, model: "local scripted HTTP fixture; production harness", clients: [] };

async function command(program: string, args: string[], inherited = false): Promise<{ code: number; stdout: string }> {
  const child = spawn(program, args, { cwd, env, stdio: inherited ? "inherit" : ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  if (code && !inherited) throw new Error(`${program} failed (${code}): ${stderr}`);
  return { code, stdout };
}

try {
  report.agentVersion = (await command(process.execPath, [executable, "--version"])).stdout.trim();
  await command(process.execPath, [...args, "--login", "--api-key", "opk_qualification_fixture"]);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const updates: acp.SessionNotification[] = [];
  const client = acp.client().onNotification("session/update", ctx => { updates.push(ctx.params); }).onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "allow" } })).connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  child.once("error", error => client.close(error));
  child.once("exit", code => { if (code) client.close(new Error(`Packaged ACP exited ${code}: ${stderr}`)); });
  let id: string;
  try {
    await client.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await client.agent.request("session/new", { cwd, mcpServers: [] }); id = session.sessionId;
    await client.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "plan proof" }] });
    assert(updates.some(event => event.update.sessionUpdate === "plan" && event.update.entries[0]?.status === "completed"));
    assert.equal((await client.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "command proof" }] })).stopReason, "end_turn");
    assert(updates.some(event => event.update.sessionUpdate === "tool_call_update" && event.update.status === "completed"));
    assert(updates.some(event => event.update.sessionUpdate === "tool_call_update" && JSON.stringify(event.update).includes("ACP tool proof")));
  } finally {
    client.close(); child.stdin.end();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
  }
  (report.clients as unknown[]).push({ name: "official TypeScript ACP client", version: "1.7.0", commandPermission: "allow once", prompt: "passed" });
  const replay: unknown[] = [];
  const independent = new AcpClient({ command: process.execPath, args, cwd, env, requestTimeoutMs: 20_000, onUpdate: (_session, update) => { replay.push(update); } });
  try {
    await independent.loadSession(id!, cwd);
    assert(replay.some(update => (update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk"));
    assert(replay.some(update => (update as { sessionUpdate?: string }).sessionUpdate === "plan"));
    assert.equal((await independent.prompt(id!, [{ type: "text", text: "hello after restart" }])).stopReason, "end_turn");
  } finally { await independent.stop(); }
  (report.clients as unknown[]).push({ name: "OpenPond independently implemented ACP client", version: JSON.parse(await readFile(path.join(repo, "packages/agent-runtime/package.json"), "utf8")).version, restartResumeReplay: "passed" });
  if (process.env.OPENPOND_ACP_TCK_PATH) {
    const tckReport = path.join(path.dirname(reportPath), "tck.json");
    const result = await command("uv", ["--project", process.env.OPENPOND_ACP_TCK_PATH, "run", "acp-tck", "--timeout", "20", "--test-timeout", "60", "--cancel-prompt", "slow proof", "--auth-method", "openpond-account", "--report-json", tckReport, "--", process.execPath, ...args], true);
    report.tck = { exitCode: result.code, report: tckReport };
    assert.equal(result.code, 0, "ACP TCK failed; inspect its JSON report.");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
