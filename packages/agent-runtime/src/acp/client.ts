import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AcpRpcError, type AcpClientOptions, type AcpInitializeResult, type AcpObject, type AcpPermissionRequest, type AcpPermissionResult, type AcpSessionResult } from "./types.js";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const cancelled: AcpPermissionResult = { outcome: { outcome: "cancelled" } };
function object(value: unknown): value is AcpObject { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** One process owns its sessions and permission replies. Native credentials never cross this boundary. */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private sessions = new Set<string>();
  private activePrompts = new Set<string>();
  private permissions = new Map<string, Set<AbortController>>();
  private nextId = 1;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private initialized: Promise<AcpInitializeResult> | null = null;
  private updateQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: AcpClientOptions) {}

  initialize(): Promise<AcpInitializeResult> {
    if (this.initialized) return this.initialized;
    this.initialized = this.connect();
    return this.initialized;
  }

  private async connect(): Promise<AcpInitializeResult> {
    if (this.stopped) throw new Error("ACP client is closed; reconnect with a new client.");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    // Stderr may include authentication URLs or provider secrets. Never forward it into retained chat events.
    child.stderr.resume();
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => this.fail(new Error(`ACP agent exited (${signal ?? code ?? "unknown"}).`)));
    try {
      const result = await this.request("initialize", {
        protocolVersion: 1, clientInfo: { name: "openpond", title: "OpenPond", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
      }) as AcpInitializeResult;
      if (result.protocolVersion !== 1) throw new Error(`Unsupported ACP protocol version: ${result.protocolVersion}`);
      return result;
    } catch (error) { await this.stop(); throw error; }
  }

  async authenticate(methodId: string): Promise<void> {
    const info = await this.initialize();
    const method = info.authMethods?.find((candidate) => candidate.id === methodId);
    if (!method) throw new Error("The agent did not advertise this authentication method.");
    if (method.type === "terminal") throw new Error("Run the agent's terminal login, then reconnect.");
    await this.request("authenticate", { methodId });
  }

  async createSession(cwd: string, mcpServers: AcpObject[] = []): Promise<AcpSessionResult> {
    await this.initialize();
    const result = await this.request("session/new", { cwd, mcpServers }) as AcpSessionResult;
    if (typeof result.sessionId !== "string" || !result.sessionId) throw new Error("Agent returned no native session identity.");
    this.sessions.add(result.sessionId);
    return result;
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: AcpObject[] = []): Promise<AcpSessionResult> {
    const info = await this.initialize();
    if (!info.agentCapabilities?.loadSession) throw new Error("This agent does not support native session loading.");
    // Load may replay session/update events before replying. Admit only this explicit native identity.
    this.sessions.add(sessionId);
    try {
      const result = await this.request("session/load", { sessionId, cwd, mcpServers }) as Omit<AcpSessionResult, "sessionId">;
      await this.updateQueue;
      return { ...result, sessionId };
    } catch (error) { this.sessions.delete(sessionId); throw error; }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.assertSession(sessionId);
    await this.request("session/set_model", { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.assertSession(sessionId);
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async prompt(sessionId: string, prompt: AcpObject[], signal?: AbortSignal): Promise<{ stopReason: string }> {
    this.assertSession(sessionId);
    if (signal?.aborted) throw new Error("ACP prompt cancelled.");
    if (this.activePrompts.has(sessionId)) throw new Error("A prompt is already active for this native session.");
    this.activePrompts.add(sessionId);
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      this.cancel(sessionId);
      // A non-cooperating agent must not retain tools/approvals indefinitely after cancellation.
      cancellationTimer = setTimeout(() => { void this.stop(); }, 5_000);
      cancellationTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.request("session/prompt", { sessionId, prompt }, 0) as { stopReason: string };
      await this.updateQueue;
      return result;
    } finally {
      if (cancellationTimer) clearTimeout(cancellationTimer);
      signal?.removeEventListener("abort", abort);
      this.activePrompts.delete(sessionId);
      this.cancelPermissions(sessionId);
    }
  }

  cancel(sessionId: string): void {
    this.cancelPermissions(sessionId);
    if (this.sessions.has(sessionId) && this.child) this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.fail(new Error("ACP connection closed."));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      kill.unref();
      child.once("exit", () => { clearTimeout(kill); resolve(); });
      child.kill("SIGTERM");
    });
  }

  private assertSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error("Session does not belong to this ACP connection.");
  }

  private request(method: string, params: AcpObject, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { if (timer) clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private write(message: AcpObject): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("ACP connection is not running.");
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) throw new Error("ACP frame exceeds the size limit.");
    this.child.stdin.write(`${serialized}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("ACP frame exceeds the size limit.");
        this.receive(JSON.parse(line));
      } catch { this.fail(new Error("Invalid ACP protocol frame.")); void this.stop(); return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) { this.fail(new Error("ACP frame exceeds the size limit.")); void this.stop(); }
  }

  private receive(message: unknown): void {
    if (!object(message) || message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope.");
    if (typeof message.method === "string") {
      if ("id" in message) { void this.handleRequest(message); return; }
      if (message.method === "session/update" && object(message.params)) {
        const { sessionId, update } = message.params;
        if (typeof sessionId !== "string" || !this.sessions.has(sessionId) || !object(update)) return;
        this.updateQueue = this.updateQueue.then(async () => { await this.options.onUpdate?.(sessionId, update); });
        void this.updateQueue.catch((error: Error) => { this.fail(error); void this.stop(); });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (object(message.error)) pending.reject(new AcpRpcError(Number(message.error.code), String(message.error.message), message.error.data));
    else pending.resolve(message.result);
  }

  private async handleRequest(message: AcpObject): Promise<void> {
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    try {
      if (message.method !== "session/request_permission") {
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Client method not supported." } });
        return;
      }
      const params = message.params;
      if (!object(params) || typeof params.sessionId !== "string" || !Array.isArray(params.options) || !object(params.toolCall)) throw new Error("Invalid permission request.");
      this.assertSession(params.sessionId);
      if (!this.activePrompts.has(params.sessionId)) { this.write({ jsonrpc: "2.0", id, result: cancelled }); return; }
      const controller = new AbortController();
      const controllers = this.permissions.get(params.sessionId) ?? new Set<AbortController>();
      controllers.add(controller);
      this.permissions.set(params.sessionId, controllers);
      let result: AcpPermissionResult = cancelled;
      try {
        if (this.options.onPermission) result = await Promise.race([
          this.options.onPermission(params as AcpPermissionRequest, controller.signal),
          new Promise<AcpPermissionResult>((resolve) => controller.signal.addEventListener("abort", () => resolve(cancelled), { once: true })),
        ]);
        if (controller.signal.aborted) result = cancelled;
        if (result.outcome.outcome === "selected") {
          const selectedId = result.outcome.optionId;
          if (!params.options.some((option) => object(option) && option.optionId === selectedId)) throw new Error("Permission option was not advertised by the agent.");
        }
      } finally { controllers.delete(controller); if (!controllers.size) this.permissions.delete(params.sessionId); }
      if (this.child) this.write({ jsonrpc: "2.0", id, result });
    } catch {
      if (this.child) this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid or expired client request." } });
    }
  }

  private cancelPermissions(sessionId: string): void {
    for (const controller of this.permissions.get(sessionId) ?? []) controller.abort();
    this.permissions.delete(sessionId);
  }

  private fail(error: Error): void {
    const child = this.child;
    const wasConnected = Boolean(child);
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      kill.unref();
      child.once("exit", () => clearTimeout(kill));
    }
    for (const pending of this.pending.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const sessionId of this.sessions) this.cancelPermissions(sessionId);
    this.sessions.clear();
    if (wasConnected) this.options.onExit?.(error);
  }
}
