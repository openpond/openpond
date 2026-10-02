import { signalNativeProcess } from "./process-tree.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AcpClientOptions, AcpInitializeResult, AcpObject, AcpPermissionResult, AcpSessionResult, NativeAgentQuestion } from "./types.js";

const record = (value: unknown): AcpObject => value && typeof value === "object" && !Array.isArray(value) ? value as AcpObject : {};
/** Native Claude CLI control protocol; credentials and conversation persistence remain with Claude. */
export class ClaudeCliClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;
  private pending = new Map<string, { resolve(value: AcpObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private turn: { resolve(value: { stopReason: string }): void; reject(error: Error): void } | null = null;
  private permissions = new Set<AbortController>();
  private updates: Promise<void> = Promise.resolve();
  private closed = false;
  private model = "default";
  constructor(private readonly options: AcpClientOptions) {}
  async initialize(): Promise<AcpInitializeResult> {
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [], agentInfo: { name: "Claude Code CLI", version: "native" } };
  }
  async authenticate(_methodId: string): Promise<void> { throw new Error("Use Claude Code's native login, then reconnect."); }
  async createSession(cwd: string, servers: AcpObject[] = []): Promise<AcpSessionResult> { return this.start(randomUUID(), cwd, false, servers); }
  async loadSession(sessionId: string, cwd: string, servers: AcpObject[] = []): Promise<AcpSessionResult> { return this.start(sessionId, cwd, true, servers); }
  private async start(sessionId: string, cwd: string, resume: boolean, servers: AcpObject[]): Promise<AcpSessionResult> {
    if (this.child || this.closed) throw new Error("Claude connection already owns a session or is closed.");
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Invalid native Claude session identity.");
    this.sessionId = sessionId;
    const mcpServers = Object.fromEntries(servers.map((server) => [String(server.name), { type: "http", url: server.url, headers: Object.fromEntries((Array.isArray(server.headers) ? server.headers : []).map((header) => { const item = record(header); return [String(item.name), String(item.value)]; })) }]));
    const child = spawn(this.options.command, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "stdio", ...(servers.length ? ["--mcp-config", JSON.stringify({ mcpServers })] : []), resume ? "--resume" : "--session-id", sessionId], { cwd, env: this.options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
    this.child = child;
    const decoder = new StringDecoder("utf8"); let buffer = "";
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk); let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("Oversized frame"); this.receive(record(JSON.parse(line))); }
        catch { this.fail(new Error("Invalid Claude CLI protocol frame.")); void this.stop(); return; }
      }
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { this.fail(new Error("Claude CLI frame exceeds limit.")); void this.stop(); }
    });
    child.on("error", (error) => this.fail(error)); child.stdin.on("error", (error) => this.fail(error));
    child.on("exit", (code) => { this.fail(new Error(`Claude CLI exited (${code ?? "signal"}).`)); signalNativeProcess(child, "SIGTERM"); const cleanup = setTimeout(() => signalNativeProcess(child, "SIGKILL"), 2_000); cleanup.unref(); this.child = null; });
    try {
      const init = await this.control({ subtype: "initialize", hooks: null });
      const models = Array.isArray(init.models) ? init.models.map(record).filter((model) => typeof model.value === "string") : [];
      return { sessionId, models: { currentModelId: this.model, availableModels: models.map((model) => ({ modelId: String(model.value), name: String(model.displayName ?? model.value) })) }, modes: { currentModeId: String(init.current_permission_mode ?? "manual"), availableModes: [{ id: "manual", name: "Ask for permissions" }, { id: "plan", name: "Plan" }] } };
    } catch (error) { await this.stop(); throw error; }
  }
  async setModel(sessionId: string, modelId: string): Promise<void> { this.assertSession(sessionId); await this.control({ subtype: "set_model", model: modelId }); this.model = modelId; }
  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.assertSession(sessionId); if (!["manual", "plan"].includes(modeId)) throw new Error("Unsupported Claude permission mode.");
    await this.control({ subtype: "set_permission_mode", mode: modeId });
  }
  async prompt(sessionId: string, prompt: AcpObject[], signal?: AbortSignal): Promise<{ stopReason: string }> {
    this.assertSession(sessionId); if (this.turn) throw new Error("A prompt is already active for this native session."); if (signal?.aborted) throw new Error("Claude turn cancelled.");
    const promise = new Promise<{ stopReason: string }>((resolve, reject) => { this.turn = { resolve, reject }; });
    let kill: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { for (const controller of this.permissions) controller.abort(); void this.control({ subtype: "interrupt" }).catch(() => undefined); kill = setTimeout(() => { void this.stop(); }, 5_000); kill.unref(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      this.write({ type: "user", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: prompt.map((part) => part.type === "image" ? { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } } : part) } });
      const result = await promise; await this.updates; return signal?.aborted ? { stopReason: "cancelled" } : result;
    } catch (error) { if (signal?.aborted) return { stopReason: "cancelled" }; throw error;
    } finally { signal?.removeEventListener("abort", abort); if (kill) clearTimeout(kill); this.turn = null; for (const controller of this.permissions) controller.abort(); this.permissions.clear(); }
  }
  private assertSession(id: string): void { if (!this.child || this.sessionId !== id || this.closed) throw new Error("Session does not belong to this Claude connection."); }
  private write(message: AcpObject): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Claude connection is closed."); const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("Claude input exceeds limit."); this.child.stdin.write(`${line}\n`);
  }
  private control(request: AcpObject): Promise<AcpObject> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Claude control request timed out: ${request.subtype}`)); }, this.options.requestTimeoutMs ?? 30_000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ type: "control_request", request_id: id, request }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private emit(update: AcpObject): void {
    if (!this.turn || !this.sessionId) return; const id = this.sessionId;
    this.updates = this.updates.then(async () => { await this.options.onUpdate?.(id, update); });
    void this.updates.catch((error: Error) => { this.fail(error); void this.stop(); });
  }
  private receive(message: AcpObject): void {
    if (typeof message.session_id === "string" && message.session_id !== this.sessionId) {
      this.fail(new Error("Claude changed native session identity.")); void this.stop(); return;
    }
    if (message.type === "control_response") {
      const response = record(message.response), id = String(response.request_id), pending = this.pending.get(id);
      if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id);
      if (response.subtype === "error") pending.reject(new Error(String(response.error ?? "Claude control failed."))); else pending.resolve(record(response.response));
    } else if (message.type === "control_request") { void this.permission(message); }
    else if (message.type === "stream_event") {
      const raw = record(message.event), delta = record(raw.delta), block = record(raw.content_block);
      if (raw.type === "content_block_delta" && (delta.type === "text_delta" || delta.type === "thinking_delta")) this.emit({ sessionUpdate: delta.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk", content: { type: "text", text: delta.text ?? delta.thinking ?? "" } });
      if (raw.type === "content_block_start" && block.type === "tool_use") this.emit({ sessionUpdate: "tool_call", toolCallId: block.id, title: block.name, kind: "other", status: "in_progress", rawInput: block.input });
    } else if (message.type === "assistant") {
      const content = record(message.message).content;
      for (const block of Array.isArray(content) ? content.map(record) : []) if (block.type === "tool_use") this.emit({ sessionUpdate: "tool_call_update", toolCallId: block.id, title: block.name, status: "in_progress", rawInput: block.input });
    } else if (message.type === "user") {
      const content = record(message.message).content;
      for (const block of Array.isArray(content) ? content.map(record) : []) if (block.type === "tool_result") this.emit({ sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error ? "failed" : "completed", content: block.content });
    } else if (message.type === "result") {
      if (message.session_id && message.session_id !== this.sessionId) { this.fail(new Error("Claude changed native session identity.")); return; }
      this.emit({ sessionUpdate: "usage_update", usage: message.usage, totalCostUsd: message.total_cost_usd });
      if (message.is_error) this.turn?.reject(new Error(Array.isArray(message.errors) ? message.errors.map(String).join("; ") : "Claude turn failed.")); else this.turn?.resolve({ stopReason: "end_turn" });
    }
  }
  private async permission(message: AcpObject): Promise<void> {
    const request = record(message.request), id = String(message.request_id);
    if (request.subtype !== "can_use_tool" || !this.turn || !this.sessionId) { this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported or inactive control request." } }); return; }
    const controller = new AbortController(); this.permissions.add(controller);
    try {
      const input = record(request.input);
      const questions = request.tool_name === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions as NativeAgentQuestion[] : undefined;
      const cancelled = new Promise<AcpPermissionResult>((resolve) => controller.signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true }));
      const result = await Promise.race([cancelled, this.options.onPermission?.({ sessionId: this.sessionId, toolCall: { toolCallId: request.tool_use_id, title: request.title ?? request.tool_name, rawInput: request.input }, questions, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }, controller.signal)]);
      const allow = !controller.signal.aborted && result?.outcome.outcome === "selected" && result.outcome.optionId === "allow";
      if (this.child) this.write({ type: "control_response", response: { subtype: "success", request_id: id, response: allow ? { behavior: "allow", updatedInput: questions ? { ...input, answers: result?.answers } : request.input } : { behavior: "deny", message: "Permission declined or turn cancelled." } } });
    } catch { if (this.child) this.write({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "deny", message: "Permission could not be resolved." } } }); }
    finally { this.permissions.delete(controller); }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); this.turn?.reject(error); this.turn = null;
    for (const controller of this.permissions) controller.abort(); this.permissions.clear(); this.options.onExit?.(error);
  }
  async stop(): Promise<void> {
    if (this.closed) return; this.closed = true; this.fail(new Error("Claude connection closed.")); const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => { const timer = setTimeout(() => signalNativeProcess(child, "SIGKILL"), 2_000); timer.unref(); child.once("exit", () => { clearTimeout(timer); resolve(); }); signalNativeProcess(child, "SIGTERM"); }); this.child = null;
  }
}
