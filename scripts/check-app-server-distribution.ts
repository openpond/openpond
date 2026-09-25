import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessCommand } from "../apps/cli/src/process-runner";

/** Exercise the published API from a fresh npm consumer, outside workspace resolution. */
export async function checkAppServerDistribution(input: {
  root: string;
  consumer: string;
  command: (name: string, args: string[], options?: { cwd?: string }) => Promise<unknown>;
}): Promise<"passed"> {
  const source = path.join(input.consumer, "app-server-consumer.mts");
  await writeFile(source, `
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  createOpenPondAppServer, runAppServerJsonl, AGENT_PROTOCOL_VERSION,
  type AppServerToolBinding, type OpenPondAppServerOptions,
} from "openpond/app-server";

// This binding checks that public types compose with the consumer's own Zod.
const binding: AppServerToolBinding = {
  name: "example", version: "1", inputSchema: z.object({ week: z.number() }),
  async execute({ args, signal }) { signal.throwIfAborted(); return { week: args.week }; },
};
assert.equal(binding.version, "1");
assert.equal(typeof runAppServerJsonl, "function");
assert.equal(typeof AGENT_PROTOCOL_VERSION, "string");
let finalized = false;
const options: OpenPondAppServerOptions = {
  storeDir: "./app-server-state", workspaceDir: "./workspace",
  embedding: { allowedTools: [], async authorizeTool() { throw new Error("No tools permitted"); } },
  async *streamOpenPondHostedChatTurn() {
    yield { type: "text_delta", raw: null, text: "Packaged Work response" };
    yield { type: "finish", raw: null, finishReason: "stop" };
  },
  async workInputsForSession() { return []; },
  async finalizeWorkTurn({ session }) { finalized = true; return session; },
};
await mkdir("./workspace", { recursive: true });
const server = await createOpenPondAppServer(options);
try {
  const started = await server.runtime.threadStart({ session: {
    provider: "openpond", experience: "work", title: "Package fixture",
    modelRef: { providerId: "openpond", modelId: "fixture" },
  } }) as { thread: { id: string } };
  const result = await server.runtime.turnStart({ threadId: started.thread.id, input: { prompt: "Hello" } }) as { turn: { status: string; error?: string } };
  assert.equal(result.turn.status, "completed", JSON.stringify(result));
  assert.equal(finalized, true);
} finally { await server.close(); }
`);
  await input.command(process.execPath, [
    path.join(input.root, "node_modules/typescript/bin/tsc"),
    "--strict", "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--target", "ES2022", "--types", "node", "--typeRoots", path.join(input.root, "node_modules/@types"), source,
  ], { cwd: input.consumer });
  await input.command(process.execPath, [source], { cwd: input.consumer });
  // The JSONL entrypoint must inherit the invocation cwd even when the package
  // is installed elsewhere. This replaces the weaker workspace-installed smoke.
  const cwd = path.join(input.consumer, "workspace");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-09-20", client: { name: "packed-consumer", version: "1" } } },
    { jsonrpc: "2.0", method: "initialized" },
    { jsonrpc: "2.0", id: 2, method: "runtime/capabilities", params: {} },
    { jsonrpc: "2.0", id: 3, method: "harness/validate", params: {} },
    { jsonrpc: "2.0", id: 4, method: "thread/start", params: { session: {
      provider: "openpond", modelRef: { providerId: "openpond", modelId: "openpond-chat" }, experience: "work", title: "Installed cwd proof",
    } } },
  ];
  const result = await runProcessCommand(process.execPath, [
    path.join(input.consumer, "node_modules/openpond/dist/cli.js"), "app-server", "--home", path.join(input.consumer, "jsonl-state"),
  ], { cwd, env: { OPENPOND_FORCE_EMBEDDED_COMPANIONS: "1", OPENPOND_HARNESS_SCRIPTED_MODELS: "1" },
    stdin: messages.map((message) => JSON.stringify(message)).join("\n") + "\n", timeoutMs: 20_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr.trim(), "");
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 5);
  assert.equal(responses.find((message) => message.id === 2)?.result?.placement, "hosted_work");
  assert.equal(responses.find((message) => message.id === 3)?.result?.valid, true);
  assert.equal(responses.find((message) => message.id === 4)?.result?.thread?.cwd, await realpath(cwd));
  return "passed";
}
