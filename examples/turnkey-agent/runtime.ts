import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createOpenPondAppServer, type OpenPondAppServerInstance } from "../../apps/server/src/app-server-runtime.js";
import { type ChatInput, type Config, ExampleError } from "./config.js";
import { writeExampleHarness } from "./harness.js";
import { createModelStream } from "./model.js";
import { createHashTool, hashTool, type ToolEvidence } from "./sandbox.js";

export type ChatResult = { answer: string; threadId: string; turnId: string; tools: ToolEvidence[] };

async function withRuntime<T>(config: Config, input: ChatInput, signal: AbortSignal,
  use: (server: OpenPondAppServerInstance, evidence: ToolEvidence[]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-tvc-request-"));
  let server: OpenPondAppServerInstance | undefined;
  const evidence: ToolEvidence[] = [];
  try {
    signal.throwIfAborted();
    const harnessDir = path.join(root, "harness");
    await writeExampleHarness(harnessDir);
    const tool = createHashTool(config, input.credentials, signal, evidence);
    server = await createOpenPondAppServer({
      storeDir: path.join(root, "state"), workspaceDir: path.join(root, "work"),
      harness: { sourceDirectory: harnessDir, workspaceId: "tvc-example", name: "Turnkey example" },
      maxHostedWorkspaceToolRounds: 3,
      streamOpenPondHostedChatTurn: createModelStream(config, input.credentials, signal),
      embedding: {
        allowedTools: [hashTool.name], maxToolOutputBytes: 8192,
        authorizeTool: async ({ name }) => {
          signal.throwIfAborted();
          if (name !== hashTool.name) throw new ExampleError("tool_not_allowed", 403);
        },
        resolveTools: async () => [tool],
      },
      services: { webSearch: false, scheduling: false, connectedApps: false, tasksets: false,
        projectActions: false, profileActions: false, backgroundReview: false },
    });
    signal.throwIfAborted();
    return await use(server, evidence);
  } finally {
    try { await server?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

/** Health readiness proves real SQLite + harness initialization, without an external call. */
export async function probeRuntime(config: Config): Promise<void> {
  await withRuntime(config, { prompt: "startup", credentials: { modelApiKey: "unused", sandboxApiKey: "unused" } },
    AbortSignal.timeout(30_000), async server => {
      await server.runtime.capabilities({});
    });
}

export async function runChat(config: Config, input: ChatInput, signal: AbortSignal): Promise<ChatResult> {
  return withRuntime(config, input, signal, async (server, tools) => {
    const started = z.object({ thread: z.object({ id: z.string() }) }).parse(await server.runtime.threadStart({
      session: { provider: "openpond", modelRef: { providerId: "openpond", modelId: config.model },
        experience: "work", title: "TVC example", cwd: server.workspaceDir },
    }));
    const threadId = started.thread.id;
    const interrupt = () => { void server.runtime.turnInterrupt({ threadId, reason: "Example request cancelled" }).catch(() => {}); };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      signal.throwIfAborted();
      const { turn } = z.object({ turn: z.object({ id: z.string(), status: z.string() }) }).parse(
        await server.runtime.turnStart({ threadId, input: { prompt: input.prompt } }));
      signal.throwIfAborted();
      if (turn.status !== "completed") throw new ExampleError(`agent_turn_${turn.status}`);
      const history = z.object({ events: z.array(z.object({
        name: z.string(), turnId: z.string().nullable().optional(), output: z.string().nullable().optional(),
      })) }).parse(await server.runtime.threadRead({ threadId }));
      const answer = history.events.filter(event => event.turnId === turn.id && event.name === "assistant.delta")
        .map(event => event.output ?? "").join("");
      if (!answer || Buffer.byteLength(answer) > 64 * 1024) throw new ExampleError("invalid_agent_answer");
      return { answer, threadId, turnId: turn.id, tools };
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  });
}
