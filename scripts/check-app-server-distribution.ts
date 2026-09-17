import { writeFile } from "node:fs/promises";
import path from "node:path";

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
  return "passed";
}
