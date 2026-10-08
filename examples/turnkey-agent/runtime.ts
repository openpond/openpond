import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createOpenPondAppServer, type OpenPondAppServerInstance } from "../../apps/server/src/app-server-runtime.js";
import { type ChatInput, type Config, ExampleError } from "./config.js";
import { EMBEDDED_INSTRUCTIONS, writeExampleHarness } from "./harness.js";
import { createModelStream } from "./model.js";
import { createHashTool, hashTool, type ToolEvidence } from "./sandbox.js";
import type { EmbeddedModel } from "./local-model/runtime.js";

export type ChatResult = { answer: string; threadId: string; turnId: string; tools: ToolEvidence[] };

async function withRuntime<T>(config: Config, input: ChatInput, signal: AbortSignal,
  use: (server: OpenPondAppServerInstance, evidence: ToolEvidence[]) => Promise<T>, model?: EmbeddedModel): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-tvc-request-"));
  let server: OpenPondAppServerInstance | undefined;
  const evidence: ToolEvidence[] = [];
  try {
    signal.throwIfAborted();
    const harnessDir = path.join(root, "harness");
    const embedded = config.mode === "embedded";
    if (embedded && !model?.ready()) throw new ExampleError("model_unavailable", 503);
    if (!embedded && !("credentials" in input)) throw new ExampleError("credentials_required", 400);
    await writeExampleHarness(harnessDir, embedded);
    const tool = config.mode === "external" && "credentials" in input
      ? createHashTool(config, input.credentials, signal, evidence) : undefined;
    const stream = embedded
      ? createModelStream({ modelEndpoint: model!.endpoint, model: config.model, maxOutputTokens: 256,
        systemPrompt: EMBEDDED_INSTRUCTIONS, temperature: 0 }, { modelApiKey: "local" }, signal)
      : createModelStream(config, (input as import("./config.js").ExternalChatInput).credentials, signal);
    server = await createOpenPondAppServer({
      storeDir: path.join(root, "state"), workspaceDir: path.join(root, "work"),
      harness: { sourceDirectory: harnessDir, workspaceId: "tvc-example", name: "Turnkey example" },
      maxHostedWorkspaceToolRounds: 3,
      streamOpenPondHostedChatTurn: stream,
      embedding: {
        allowedTools: tool ? [hashTool.name] : [], maxToolOutputBytes: 8192,
        authorizeTool: async ({ name }) => {
          signal.throwIfAborted();
          if (!tool || name !== hashTool.name) throw new ExampleError("tool_not_allowed", 403);
        },
        resolveTools: async () => tool ? [tool] : [],
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
export async function probeRuntime(config: Config, model?: EmbeddedModel): Promise<void> {
  await withRuntime(config, config.mode === "embedded" ? { prompt: "startup" } : { prompt: "startup", credentials: { modelApiKey: "unused", sandboxApiKey: "unused" } },
    AbortSignal.timeout(30_000), async server => {
      await server.runtime.capabilities({});
    }, model);
}

export async function runChat(config: Config, input: ChatInput, signal: AbortSignal, model?: EmbeddedModel): Promise<ChatResult> {
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
  }, model);
}
