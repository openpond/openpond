import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { HostedChatMessage, HostedChatTool, HostedChatToolCall, HostedChatToolChoice } from "@openpond/cloud";
import type { LocalModelChatConfiguration } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { supportsCrossSystemToolCalling } from "./local-adapter-models.js";
import {
  crossSystemToolsFromRequest,
  parseLocalAdapterOutput,
  serializeLocalAdapterMessages,
} from "./local-adapter-tool-protocol.js";

type RuntimeTarget = {
  key: string;
  modelId: string;
  modelPath: string | null;
  adapterPath: string;
  baseModelId: string;
  baseModelRevision: string;
  chatTemplateHash: string;
  configuration: LocalModelChatConfiguration;
  toolCalling: boolean;
};

type WorkerEvent =
  | { id: string; type: "delta"; text: string }
  | { id: string; type: "complete"; usage: unknown }
  | { id: string; type: "error"; error: string };

export type LocalAdapterChatDelta = {
  text?: string;
  usage?: unknown;
  finishReason?: string;
  toolCalls?: HostedChatToolCall[];
  raw?: unknown;
};

export function createLocalAdapterChatRuntime(deps: {
  store: SqliteStore;
  projectDir: string;
  resolveModelPath: (modelId: string, revision: string) => Promise<string | null>;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
}) {
  let activeWorker: LocalAdapterWorker | null = null;
  let workerTransition = Promise.resolve();

  async function workerFor(target: RuntimeTarget): Promise<LocalAdapterWorker> {
    const transition = workerTransition.then(async () => {
      if (activeWorker?.key === target.key && !activeWorker.closed) return activeWorker;
      await activeWorker?.close();
      const worker = new LocalAdapterWorker({
        target,
        projectDir: deps.projectDir,
        idleTimeoutMs: deps.idleTimeoutMs ?? target.configuration.keepWarmSeconds * 1_000,
        startupTimeoutMs: deps.startupTimeoutMs ?? 120_000,
        onIdle: (candidate) => {
          if (activeWorker === candidate) activeWorker = null;
        },
      });
      activeWorker = worker;
      await worker.ready();
      return worker;
    });
    workerTransition = transition.then(() => undefined, () => undefined);
    return transition;
  }

  async function* stream(input: {
    modelId: string | null | undefined;
    messages: HostedChatMessage[];
    requestId: string;
    signal: AbortSignal;
    maxNewTokens?: number;
    temperature?: number;
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
  }): AsyncGenerator<LocalAdapterChatDelta, void, unknown> {
    const target = await resolveRuntimeTarget(deps, input.modelId);
    const worker = await workerFor(target);
    const tools = target.toolCalling ? crossSystemToolsFromRequest(input.tools, input.toolChoice) : [];
    if ((input.tools?.length ?? 0) > 0 && !target.toolCalling) throw new Error("This local adapter was not trained from the conformed Cross-System Operations tool contract.");
    const workerMessages = tools.length
      ? serializeLocalAdapterMessages({ messages: input.messages, tools, toolChoice: input.toolChoice })
      : input.messages;
    let buffered = "";
    for await (const event of worker.stream({
      requestId: input.requestId,
      messages: workerMessages,
      signal: input.signal,
      maxNewTokens: input.maxNewTokens ?? target.configuration.maxOutputTokens,
      contextWindowTokens: target.configuration.contextWindowTokens,
      temperature: input.temperature ?? target.configuration.temperature,
      repetitionPenalty: target.configuration.repetitionPenalty,
      noRepeatNgramSize: target.configuration.noRepeatNgramSize,
    })) {
      if (event.type === "delta") {
        if (tools.length) buffered += event.text;
        else yield { text: event.text, raw: event };
      }
      if (event.type === "complete") {
        if (tools.length) {
          const parsed = parseLocalAdapterOutput(buffered, tools);
          if (parsed.type === "tool_call") yield { toolCalls: [parsed.toolCall], raw: { ...event, constrainedOutput: buffered } };
          else if (parsed.content) yield { text: parsed.content, raw: { ...event, constrainedOutput: buffered } };
          yield { usage: event.usage, raw: event };
          yield { finishReason: parsed.type === "tool_call" ? "tool_calls" : "stop", raw: event };
          continue;
        }
        yield { usage: event.usage, raw: event };
        yield { finishReason: "stop", raw: event };
      }
    }
  }

  async function close(): Promise<void> {
    await workerTransition;
    const worker = activeWorker;
    activeWorker = null;
    await worker?.close();
  }

  return { stream, close };
}

async function resolveRuntimeTarget(
  deps: {
    store: SqliteStore;
    projectDir: string;
    resolveModelPath: (modelId: string, revision: string) => Promise<string | null>;
  },
  modelId: string | null | undefined,
): Promise<RuntimeTarget> {
  if (!modelId) throw new Error("Select an imported local model before chatting.");
  const lineage = await deps.store.getModelArtifactLineage(modelId);
  if (!lineage || lineage.status !== "imported") throw new Error("The selected local model is not an imported adapter.");
  const [artifact, job] = await Promise.all([
    deps.store.getTrainingArtifact(lineage.artifactId),
    deps.store.getTrainingJob(lineage.jobId),
  ]);
  if (!artifact || artifact.kind !== "adapter" || !job || job.status !== "succeeded") {
    throw new Error("The selected local model does not have a completed adapter artifact.");
  }
  if (!artifact.baseModelId || !artifact.baseModelRevision || !artifact.chatTemplateHash) {
    throw new Error("The adapter lineage is missing its pinned base model or chat template.");
  }
  await access(artifact.path).catch(() => {
    throw new Error("The selected adapter is unavailable. Reconnect its storage and refresh Training.");
  });
  const fixtureModel = artifact.baseModelId === "openpond/tiny-cpu-gpt2-fixture";
  const modelPath = fixtureModel ? null : await deps.resolveModelPath(artifact.baseModelId, artifact.baseModelRevision);
  if (!fixtureModel && !modelPath) {
    throw new Error(`The pinned base model ${artifact.baseModelId} is not available in Compute settings.`);
  }
  const taskset = await deps.store.getTaskset(lineage.tasksetId);
  return {
    key: `${lineage.id}:${artifact.sha256}:${lineage.chatConfiguration.updatedAt ?? "defaults"}`,
    modelId: lineage.id,
    modelPath,
    adapterPath: path.dirname(artifact.path),
    baseModelId: artifact.baseModelId,
    baseModelRevision: artifact.baseModelRevision,
    chatTemplateHash: artifact.chatTemplateHash,
    configuration: lineage.chatConfiguration,
    toolCalling: Boolean(taskset && supportsCrossSystemToolCalling(taskset)),
  };
}

class LocalAdapterWorker {
  readonly key: string;
  closed = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, AsyncEventChannel>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private stderr = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly input: {
    target: RuntimeTarget;
    projectDir: string;
    idleTimeoutMs: number;
    startupTimeoutMs: number;
    onIdle: (worker: LocalAdapterWorker) => void;
  }) {
    this.key = input.target.key;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const workerArgs = [
      "run",
      "--project",
      input.projectDir,
      "openpond-inference",
      "--model-id",
      input.target.modelId,
      "--adapter-path",
      input.target.adapterPath,
      "--base-model-id",
      input.target.baseModelId,
      "--base-model-revision",
      input.target.baseModelRevision,
      "--chat-template-hash",
      input.target.chatTemplateHash,
    ];
    if (input.target.modelPath) workerArgs.push("--model-path", input.target.modelPath);
    this.child = spawn("uv", workerArgs, {
      cwd: input.projectDir,
      env: localAdapterWorkerEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-20_000);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) this.fail(new Error(this.stderr.trim() || `Local model process exited with ${code ?? signal}.`));
    });
    const startupTimeout = setTimeout(() => {
      this.fail(new Error("Local model startup timed out."));
      this.child.kill("SIGKILL");
    }, input.startupTimeoutMs);
    startupTimeout.unref?.();
    void this.readyPromise.finally(() => clearTimeout(startupTimeout)).catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async *stream(input: {
    requestId: string;
    messages: HostedChatMessage[];
    signal: AbortSignal;
    maxNewTokens: number;
    contextWindowTokens: number;
    temperature: number;
    repetitionPenalty: number;
    noRepeatNgramSize: number;
  }): AsyncGenerator<WorkerEvent, void, unknown> {
    await this.readyPromise;
    if (this.closed) throw new Error("Local model process is closed.");
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Local model request was cancelled.");
    this.clearIdleTimer();
    const id = `${input.requestId}:${randomUUID()}`;
    const channel = new AsyncEventChannel();
    this.pending.set(id, channel);
    const abort = () => {
      channel.fail(input.signal.reason instanceof Error ? input.signal.reason : new Error("Local model request was cancelled."));
      void this.close();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    this.child.stdin.write(`${JSON.stringify(localAdapterInferenceRequest({ ...input, id }))}\n`);
    try {
      for await (const event of channel.events()) yield event;
    } finally {
      input.signal.removeEventListener("abort", abort);
      this.pending.delete(id);
      if (!this.closed && this.pending.size === 0) this.scheduleIdleClose();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    for (const channel of this.pending.values()) channel.fail(new Error("Local model process closed."));
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    const timeout = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    timeout.unref?.();
    await exited;
    clearTimeout(timeout);
  }

  private handleLine(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (value.type === "ready") {
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady();
      }
      return;
    }
    const id = typeof value.id === "string" ? value.id : "";
    const channel = this.pending.get(id);
    if (!channel) return;
    if (value.type === "delta" && typeof value.text === "string") {
      channel.push({ id, type: "delta", text: value.text });
    } else if (value.type === "complete") {
      channel.push({ id, type: "complete", usage: value.usage });
      channel.complete();
    } else if (value.type === "error") {
      channel.fail(new Error(typeof value.error === "string" ? value.error : "Local model generation failed."));
    }
  }

  private fail(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const channel of this.pending.values()) channel.fail(error);
    this.pending.clear();
    this.closed = true;
    this.clearIdleTimer();
    this.input.onIdle(this);
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.input.onIdle(this);
      void this.close();
    }, this.input.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export function localAdapterInferenceRequest(input: {
  id: string;
  messages: HostedChatMessage[];
  maxNewTokens: number;
  contextWindowTokens: number;
  temperature: number;
  repetitionPenalty: number;
  noRepeatNgramSize: number;
}) {
  return {
    id: input.id,
    messages: input.messages
      .filter((message) => ["system", "user", "assistant"].includes(message.role) && message.content)
      .map((message) => ({ role: message.role, content: message.content })),
    maxNewTokens: input.maxNewTokens,
    contextWindowTokens: input.contextWindowTokens,
    temperature: input.temperature,
    repetitionPenalty: input.repetitionPenalty,
    noRepeatNgramSize: input.noRepeatNgramSize,
  };
}

class AsyncEventChannel {
  private readonly queue: WorkerEvent[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(event: WorkerEvent): void {
    if (this.done) return;
    this.queue.push(event);
    this.wake();
  }

  complete(): void {
    this.done = true;
    this.wake();
  }

  fail(error: Error): void {
    this.error = error;
    this.done = true;
    this.wake();
  }

  async *events(): AsyncGenerator<WorkerEvent, void, unknown> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}

export function localAdapterWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "UV_CACHE_DIR", "VIRTUAL_ENV"] as const;
  return {
    ...Object.fromEntries(allowed.flatMap((key) => typeof env[key] === "string" ? [[key, env[key]]] : [])),
    PYTHONUNBUFFERED: "1",
    TOKENIZERS_PARALLELISM: "false",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
}
