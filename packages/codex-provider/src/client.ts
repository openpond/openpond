import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveCodexBinary } from "./binary.js";
import { defaultServerRequestResult } from "./default-result.js";
import type {
  CodexClientOptions,
  CodexNotification,
  CodexServerRequest,
  CodexServerRequestResult,
  JsonRpcId,
  PendingRequest,
  TurnWaiter,
} from "./types.js";

type CompactThreadResult = {
  method: "thread/compact/start" | "thread/compact";
  completion: "notification" | "response";
  response: unknown;
};

export class CodexAppServerClient {
  private readonly binaryPath: string;
  private readonly clientName: string;
  private readonly clientTitle: string;
  private readonly clientVersion: string;
  private readonly onNotification?: (notification: CodexNotification) => void;
  private readonly onServerRequest?: (request: CodexServerRequest) => Promise<CodexServerRequestResult>;
  private readonly stderr?: (chunk: string) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private turnWaiters = new Map<string, TurnWaiter>();
  private initialized = false;

  constructor(options: CodexClientOptions = {}) {
    this.binaryPath = options.binaryPath ?? "codex";
    this.clientName = options.clientName ?? "openpond-app";
    this.clientTitle = options.clientTitle ?? "OpenPond App";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.stderr = options.stderr;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const resolved = await resolveCodexBinary(this.binaryPath);
    const args = resolved.supportsListen ? ["app-server", "--listen", "stdio://"] : ["app-server"];
    const child = spawn(resolved.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    let stderrBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-4000);
      this.stderr?.(chunk.toString("utf8"));
    });
    child.on("exit", (code, signal) => {
      const details = stderrBuffer.trim();
      const message = `codex app-server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}${details ? `: ${details}` : ""}`;
      for (const request of this.pending.values()) request.reject(new Error(message));
      for (const waiter of this.turnWaiters.values()) waiter.reject(new Error(message));
      this.pending.clear();
      this.turnWaiters.clear();
      this.child = null;
      this.initialized = false;
    });
  }

  async initialize(): Promise<unknown> {
    if (this.initialized) return null;
    await this.start();
    const result = await this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        title: this.clientTitle,
        version: this.clientVersion,
      },
      capabilities: null,
    });
    this.notify("initialized");
    this.initialized = true;
    return result;
  }

  async readAccount(): Promise<unknown> {
    await this.initialize();
    return this.request("account/read", {});
  }

  async startThread(params: {
    cwd?: string | null;
    model?: string | null;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    config?: Record<string, unknown> | null;
    developerInstructions?: string | null;
  }): Promise<{ threadId: string; response: unknown }> {
    await this.initialize();
    const response = (await this.request("thread/start", {
      cwd: params.cwd ?? process.cwd(),
      model: params.model ?? null,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      sandbox: params.sandbox ?? "workspace-write",
      config: params.config ?? null,
      developerInstructions: params.developerInstructions ?? null,
      threadSource: "user",
    })) as { thread?: { id?: string } };
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("codex thread/start response did not include a thread id");
    return { threadId, response };
  }

  async resumeThread(params: {
    threadId: string;
    cwd?: string | null;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    config?: Record<string, unknown> | null;
  }): Promise<{ threadId: string; response: unknown }> {
    await this.initialize();
    const response = await this.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd ?? null,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      sandbox: params.sandbox ?? "workspace-write",
      config: params.config ?? null,
    });
    return { threadId: params.threadId, response };
  }

  async startTurn(params: {
    threadId: string;
    prompt: string;
    cwd?: string | null;
    model?: string | null;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    sandboxPolicy?: unknown;
  }): Promise<{ turnId: string; response: unknown }> {
    const response = (await this.request("turn/start", {
      threadId: params.threadId,
      input: [{ type: "text", text: params.prompt, text_elements: [] }],
      cwd: params.cwd ?? null,
      model: params.model ?? null,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      sandboxPolicy: params.sandboxPolicy ?? sandboxPolicyForMode(params.sandbox),
    })) as { turn?: { id?: string } };
    const turnId = response.turn?.id;
    if (!turnId) throw new Error("codex turn/start response did not include a turn id");
    return { turnId, response };
  }

  async compactThread(params: { threadId: string }): Promise<CompactThreadResult> {
    await this.initialize();
    try {
      const response = await this.request("thread/compact/start", {
        threadId: params.threadId,
      });
      return { method: "thread/compact/start", completion: "notification", response };
    } catch (startError) {
      try {
        const response = await this.request("thread/compact", {
          threadId: params.threadId,
        });
        return { method: "thread/compact", completion: "response", response };
      } catch (compactError) {
        throw new Error(
          `Codex native manual compact is unavailable in this app-server version. thread/compact/start failed: ${errorMessage(
            startError
          )}; thread/compact failed: ${errorMessage(compactError)}`
        );
      }
    }
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<{ response: unknown }> {
    await this.initialize();
    const response = await this.request("turn/interrupt", {
      threadId: params.threadId,
      turnId: params.turnId,
    });
    return { response };
  }

  waitForTurn(turnId: string, timeoutMs = 10 * 60 * 1000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error(`codex turn ${turnId} timed out`));
      }, timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGTERM");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.nextId++;
    const payload = { id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child) return;
    const payload = params === undefined ? { method } : { method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private respond(id: JsonRpcId, result: CodexServerRequestResult): void {
    const child = this.child;
    if (!child) return;
    const payload = "result" in result ? { id, result: result.result } : { id, error: result.error };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = message.id as JsonRpcId | undefined;
    const method = typeof message.method === "string" ? message.method : null;
    if (id !== undefined && method) {
      void this.handleServerRequest({ id, method, params: message.params });
      return;
    }

    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as { message?: unknown };
        pending.reject(new Error(String(error.message ?? `codex ${pending.method} failed`)));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (method) {
      const notification = { method, params: message.params };
      this.handleNotification(notification);
    }
  }

  private handleNotification(notification: CodexNotification): void {
    this.onNotification?.(notification);
    if (notification.method !== "turn/completed") return;
    const params = notification.params as { turn?: { id?: string; status?: string; error?: unknown } } | undefined;
    const turnId = params?.turn?.id;
    if (!turnId) return;
    const waiter = this.turnWaiters.get(turnId);
    if (!waiter) return;
    this.turnWaiters.delete(turnId);
    if (params.turn?.status === "completed") {
      waiter.resolve(notification.params);
    } else {
      waiter.reject(new Error(String(params.turn?.error ?? "codex turn failed")));
    }
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    try {
      const result = this.onServerRequest ? await this.onServerRequest(request) : defaultServerRequestResult(request);
      this.respond(request.id, result);
    } catch (error) {
      this.respond(request.id, {
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

function sandboxPolicyForMode(mode?: "read-only" | "workspace-write" | "danger-full-access"): unknown {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly" };
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
