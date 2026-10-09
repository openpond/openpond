import { z } from "zod";
import { PersistenceError } from "@openpond/persistence";
import * as acp from "@agentclientprotocol/sdk";
import { SessionSchema, TurnSchema, RuntimeEventSchema, type RuntimeEvent, type Session, type Turn } from "@openpond/contracts";
import { SessionUserQuestionSchema, type SessionUserQuestion, type SessionUserQuestionResolution } from "@openpond/contracts/user-questions";
import { localPathWorkspaceId } from "@openpond/contracts/workspaces";
import { createOpenPondAppServer, type OpenPondAppServerInstance } from "../app-server-runtime.js";
import { AcpAccount, fingerprint, workspaceRoot } from "./identity.js";
import { SendTurnRequestSchema } from "@openpond/contracts/requests";
import { SessionMcp } from "./mcp.js";
import { promptInput } from "./content.js";
import { record, runtimeEvent, toolKind, updatesForEvent } from "./events.js";
import { askQuestion, permission } from "./interactions.js";
import path from "node:path";
import { readChatAttachmentImageFile } from "../chat-attachments.js";
import { acpPlanTool } from "./plan.js";

type ActivePrompt = {
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
  turnId: string | null;
  settlement: Promise<void>;
  settle(): void;
  updates: Promise<void>;
  interactions: Set<Promise<unknown>>;
  approvals: Set<string>;
  tools: Set<string>;
  question?: SessionUserQuestion;
  answer?: Promise<SessionUserQuestionResolution | null>;
};
type AttachedSession = { session: Session; mcp: SessionMcp; models: Array<{ id: string; name: string }>; active?: ActivePrompt; busy: boolean };

export type AcpAgentOptions = { home: string; version: string; model?: string };
const SnapshotSchema = z.object({ thread: SessionSchema, turns: z.array(TurnSchema), events: z.array(RuntimeEventSchema) });
const MODES: acp.SessionMode[] = [
  { id: "ask", name: "Ask permission", description: "Request permission for commands, changes and external MCP tools." },
  { id: "full-access", name: "Full access", description: "Allow local harness and supplied MCP tools without per-call confirmation." },
];
const READ_TOOLS = new Set(["read_file", "list_files", "search_files", "git_status", "git_diff", "resource_read", "resource_search", "read_resource", "search_resources", "ask_user", "update_plan", "profile_skill_read", "harness_inspect"]);

/** ACP owns transport/lifecycle only. Every model/tool round runs in the existing harness. */
export class OpenPondAcpAgent {
  private clientCapabilities: acp.ClientCapabilities = {};
  private initialized = false;
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly loading = new Set<string>();
  private readonly pendingMcp = new Set<SessionMcp>();
  private serverPromise?: Promise<OpenPondAppServerInstance>;
  private unsubscribe?: () => void;
  private closing?: Promise<void>;
  private readonly shutdown = new AbortController();
  private client?: acp.AgentContext;
  private readonly account: AcpAccount;

  constructor(readonly options: AcpAgentOptions) { this.account = new AcpAccount(options.home); }

  connect(stream: acp.Stream): acp.AgentConnection {
    const connection = acp.agent({ name: "openpond" })
      .onRequest("initialize", ctx => this.initialize(ctx.params))
      .onRequest("authenticate", async ctx => { this.requireInitialized(); if (ctx.params.methodId !== "openpond-account") throw acp.RequestError.invalidParams(); await this.account.models(); return {}; })
      .onRequest("session/new", ctx => this.newSession(ctx.params))
      .onRequest("session/load", ctx => this.loadSession(ctx.params))
      .onRequest("session/prompt", ctx => this.prompt(ctx.params, ctx.signal))
      .onRequest("session/set_mode", ctx => this.configure(ctx.params.sessionId, "mode", ctx.params.modeId))
      .onRequest("session/set_config_option", async ctx => { await this.configure(ctx.params.sessionId, ctx.params.configId, ctx.params.value); return { configOptions: this.config(this.owned(ctx.params.sessionId)) }; })
      .onRequest("session/close", async ctx => { const attached = this.owned(ctx.params.sessionId); attached.busy = true; await this.cancel(ctx.params.sessionId); await attached.active?.done; await attached.mcp.close(); this.sessions.delete(ctx.params.sessionId); return {}; })
      .onNotification("session/cancel", ctx => this.cancel(ctx.params.sessionId))
      .connect(stream);
    this.client = connection.client;
    connection.signal.addEventListener("abort", () => { void this.close(); }, { once: true });
    return connection;
  }

  private initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    if (this.initialized) throw acp.RequestError.invalidRequest(undefined, "Already initialized.");
    if (params.protocolVersion < 1) throw acp.RequestError.invalidParams(undefined, "ACP v1 is required.");
    this.initialized = true;
    this.clientCapabilities = params.clientCapabilities ?? {};
    return { protocolVersion: 1, agentInfo: { name: "openpond", title: "OpenPond", version: this.options.version },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { close: {} } },
      authMethods: [{ id: "openpond-account", name: "OpenPond account", description: "Sign in with openpond acp --login using the same home/account options, then reconnect." },
        ...(this.clientCapabilities.auth?.terminal ? [{ id: "openpond-login", name: "Sign in to OpenPond", type: "terminal" as const, args: ["--login"] }] : [])],
    };
  }

  private requireInitialized(): void {
    if (!this.initialized || this.shutdown.signal.aborted) throw acp.RequestError.invalidRequest(undefined, "ACP connection is not active.");
  }

  private async server(): Promise<OpenPondAppServerInstance> {
    this.requireInitialized();
    this.serverPromise ??= createOpenPondAppServer({ storeDir: this.options.home, version: this.options.version,
      streamOpenPondHostedChatTurn: this.account.stream,
      resolveSessionModelStream: session => this.account.streamForScope(record(session.metadata?.acpAgent).scope),
      services: { backgroundReview: false, webSearch: false, scheduling: false, connectedApps: false, tasksets: false, projectActions: false, profileActions: false },
      resolveModelTools: async context => {
        const attached = this.owned(context.session.id), active = attached.active;
        if (!active) throw new Error("ACP tool invocation has no active prompt owner.");
        active.controller.signal.throwIfAborted();
        // ACP v1 owns foreground turns. Richer background workflows keep their
        // native runtime API and cannot outlive an ACP prompt behind this adapter.
        const foregroundTools = context.tools.filter(tool => !tool.name.startsWith("openpond_subagent_") && tool.name !== "manage_sidebar_file");
        return [...foregroundTools, acpPlanTool, ...attached.mcp.tools].map(tool => ({ ...tool,
          execute: async input => {
            const signal = AbortSignal.any([input.signal, active.controller.signal]);
            signal.throwIfAborted();
            if (attached.session.openPondCommandAccessMode === "ask" && tool.name !== "exec_command" && !READ_TOOLS.has(tool.name)) {
              const kind = toolKind(tool.name);
              const accepted = await permission(this.client!, signal, context.session.id, input.callId, tool.description, kind === "edit" || kind === "delete" ? kind : "other", input.args);
              signal.throwIfAborted();
              if (!accepted) return { toolCallId: input.callId, name: tool.name, ok: false, contentText: "The client did not approve this tool invocation." };
            }
            return tool.execute({ ...input, signal });
          },
        }));
      },
    }).then(server => {
      if (!server.runtime.subscribe) throw new Error("ACP requires runtime event subscriptions.");
      this.unsubscribe = server.runtime.subscribe(notification => { const event = runtimeEvent(notification); if (event) this.onEvent(event); });
      return server;
    }).catch(error => {
      if (error instanceof PersistenceError) throw acp.RequestError.invalidRequest(undefined, `${error.issue.message} ${error.issue.action ?? ""}`);
      throw error;
    });
    return this.serverPromise;
  }

  private owned(id: string): AttachedSession {
    this.requireInitialized();
    const attached = this.sessions.get(id);
    if (!attached) throw acp.RequestError.resourceNotFound(id);
    return attached;
  }

  private async validateIdentity(attached: AttachedSession): Promise<void> {
    const server = await this.server();
    const current = SnapshotSchema.parse(await server.runtime.threadRead({ threadId: attached.session.id, includeHistory: false }));
    const session = SessionSchema.parse(current.thread), identity = record(session.metadata?.acpAgent);
    if (identity.version !== 1 || identity.scope !== await this.account.scope() || identity.cwd !== session.cwd || identity.profile !== fingerprint(session.currentProfile ?? null) || identity.mcp !== attached.mcp.identity || identity.harness !== fingerprint(await server.pinSessionHarness(session.id))) {
      throw acp.RequestError.invalidRequest(undefined, "ACP session ownership changed. Start a new session.");
    }
    attached.session = session;
  }

  private async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.requireInitialized();
    const cwd = await workspaceRoot(params.cwd, params.additionalDirectories), scope = await this.account.scope();
    const models = await this.account.models(), model = this.options.model ?? (models.some(model => model.id === "openpond-chat") ? "openpond-chat" : models[0]!.id);
    if (!models.some(entry => entry.id === model)) throw acp.RequestError.invalidParams(undefined, "Configured model is not available for this account.");
    const mcp = new SessionMcp(params.mcpServers, cwd);
    this.pendingMcp.add(mcp);
    try {
      await mcp.connect();
      const server = await this.server();
      this.shutdown.signal.throwIfAborted();
      const result = await server.runtime.threadStart({ session: { provider: "openpond", experience: "work", cwd, workspaceKind: "local_project", workspaceId: localPathWorkspaceId(cwd), title: "ACP chat", openPondCommandAccessMode: "ask", modelRef: { providerId: "openpond", modelId: model }, metadata: { acpAgent: { version: 1, scope, cwd, mcp: mcp.identity } } } });
      let session = SessionSchema.parse(record(result).thread);
      const harness = await server.pinSessionHarness(session.id);
      session = await server.updateSession(session.id, { metadata: { ...session.metadata, acpAgent: { ...record(session.metadata?.acpAgent), profile: fingerprint(session.currentProfile ?? null), harness: fingerprint(harness) } } });
      this.shutdown.signal.throwIfAborted();
      const attached = { session, mcp, models, busy: false };
      this.sessions.set(session.id, attached);
      return { sessionId: session.id, ...this.state(attached) };
    } catch (error) { await mcp.close(); throw error; }
    finally { this.pendingMcp.delete(mcp); }
  }

  private async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    this.requireInitialized();
    if (this.loading.has(params.sessionId) || this.sessions.get(params.sessionId)?.active || this.sessions.get(params.sessionId)?.busy) throw acp.RequestError.invalidRequest(undefined, "Session is busy.");
    this.loading.add(params.sessionId);
    let pendingMcp: SessionMcp | undefined;
    let replaying: AttachedSession | undefined;
    try {
      const cwd = await workspaceRoot(params.cwd), scope = await this.account.scope(), server = await this.server();
      let result: z.infer<typeof SnapshotSchema>;
      try { result = SnapshotSchema.parse(await server.runtime.threadResume({ threadId: params.sessionId })); }
      catch { throw acp.RequestError.resourceNotFound(params.sessionId); }
      const session = SessionSchema.parse(record(result).thread), identity = record(session.metadata?.acpAgent);
      const mcp = this.sessions.get(session.id)?.mcp ?? new SessionMcp(params.mcpServers, cwd);
      if (identity.version !== 1 || identity.cwd !== cwd || session.cwd !== cwd || identity.scope !== scope || identity.profile !== fingerprint(session.currentProfile ?? null) || identity.mcp !== fingerprint(params.mcpServers)) throw acp.RequestError.invalidRequest(undefined, "This session belongs to a different ACP workspace/account/profile/MCP scope.");
      if (identity.harness !== fingerprint(await server.pinSessionHarness(session.id))) throw acp.RequestError.invalidRequest(undefined, "The session Harness release changed.");
      if (result.turns.some(turn => TurnSchema.parse(turn).status === "in_progress")) throw acp.RequestError.invalidRequest(undefined, "Session has an unsettled turn; it cannot be redispatched.");
      const models = await this.account.models();
      if (!models.some(model => model.id === session.modelRef?.modelId)) throw acp.RequestError.invalidRequest(undefined, "The session model is no longer available.");
      if (!this.sessions.has(session.id)) { pendingMcp = mcp; this.pendingMcp.add(mcp); await mcp.connect(); }
      this.shutdown.signal.throwIfAborted();
      const attached = { session, mcp, models, busy: true };
      replaying = attached;
      this.sessions.set(session.id, attached);
      for (const turn of [...result.turns].map(value => TurnSchema.parse(value)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        await this.notify(session.id, { sessionUpdate: "user_message_chunk", messageId: `${turn.id}:user`, content: { type: "text", text: turn.prompt } });
        const started = result.events.find(event => event.turnId === turn.id && event.name === "turn.started");
        const attachments = record(started?.args).attachments;
        for (const attachment of Array.isArray(attachments) ? attachments.map(record) : []) {
          const preview = record(attachment.imagePreview);
          if (typeof preview.storageName !== "string" || typeof preview.contentType !== "string") continue;
          const image = await readChatAttachmentImageFile({ storageHome: this.options.home, attachmentRootDir: path.join(this.options.home, "attachments"), sessionId: session.id, turnId: turn.id, storageName: preview.storageName, contentType: preview.contentType });
          if (!image) throw acp.RequestError.invalidRequest(undefined, "A persisted image is unavailable for history replay.");
          await this.notify(session.id, { sessionUpdate: "user_message_chunk", messageId: `${turn.id}:user`, content: { type: "image", data: image.bytes.toString("base64"), mimeType: image.contentType } });
        }
        for (const event of (result.events as RuntimeEvent[]).filter(event => event.turnId === turn.id)) for (const update of updatesForEvent(event, cwd)) await this.notify(session.id, update);
      }
      attached.busy = false;
      this.pendingMcp.delete(mcp);
      pendingMcp = undefined;
      return this.state(attached);
    } finally {
      this.loading.delete(params.sessionId);
      if (replaying) replaying.busy = false;
      if (pendingMcp) { this.pendingMcp.delete(pendingMcp); this.sessions.delete(params.sessionId); await pendingMcp.close(); }
    }
  }

  private config(attached: AttachedSession): acp.SessionConfigOption[] {
    return [{ id: "mode", name: "Permissions", category: "mode", type: "select", currentValue: attached.session.openPondCommandAccessMode, options: MODES.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })) },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: attached.session.modelRef!.modelId, options: attached.models.map(model => ({ value: model.id, name: model.name })) }];
  }
  private state(attached: AttachedSession): acp.LoadSessionResponse {
    return { configOptions: this.config(attached), modes: { currentModeId: attached.session.openPondCommandAccessMode, availableModes: MODES } };
  }
  private async configure(id: string, key: string, value: unknown): Promise<acp.SetSessionModeResponse> {
    const attached = this.owned(id);
    if (attached.active || attached.busy || this.loading.has(id)) throw acp.RequestError.invalidRequest(undefined, "Session is busy.");
    attached.busy = true;
    try {
      await this.validateIdentity(attached);
      const server = await this.server();
      if (key === "mode" && (value === "ask" || value === "full-access")) {
        attached.session = await server.updateSession(id, { openPondCommandAccessMode: value });
        await this.notify(id, { sessionUpdate: "current_mode_update", currentModeId: value });
      } else if (key === "model" && typeof value === "string" && attached.models.some(model => model.id === value)) {
        attached.session = await server.updateSession(id, { modelRef: { providerId: "openpond", modelId: value } });
      } else throw acp.RequestError.invalidParams(undefined, "Unknown configuration option or value.");
      await this.notify(id, { sessionUpdate: "config_option_update", configOptions: this.config(attached) });
      return {};
    } finally { attached.busy = false; }
  }

  private notify(sessionId: string, update: acp.SessionUpdate): Promise<void> { return this.client!.notify(acp.methods.client.session.update, { sessionId, update }); }

  private enqueue(attached: AttachedSession, active: ActivePrompt, update: acp.SessionUpdate): void {
    active.updates = active.updates.then(() => this.notify(attached.session.id, update)).catch(() => {
      active.controller.abort();
      void this.interrupt(attached.session.id);
    });
  }

  private onEvent(event: RuntimeEvent): void {
    const attached = event.sessionId ? this.sessions.get(event.sessionId) : undefined, active = attached?.active;
    if (!attached || !active) return;
    if (event.name === "turn.started" && !active.turnId) { active.turnId = event.turnId ?? null; if (active.controller.signal.aborted) void this.interrupt(attached.session.id); }
    if (!event.turnId || event.turnId !== active.turnId) return;
    const toolId = record(event.data).toolCallId;
    if (typeof toolId === "string" && event.name === "tool.started") active.tools.add(toolId);
    if (typeof toolId === "string" && event.name === "tool.completed") active.tools.delete(toolId);
    if (!active.controller.signal.aborted && !(event.name === "user_question.asked" && this.clientCapabilities.elicitation?.form)) for (const update of updatesForEvent(event, attached.session.cwd!)) this.enqueue(attached, active, update);
    if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.name)) active.settle();
    if (event.name === "approval.requested") {
      const approval = record(event.data);
      if (typeof approval.id !== "string") return;
      const id = approval.id;
      active.approvals.add(id);
      const operation = (async () => {
        const toolCallId = [...active.tools].at(-1) ?? id;
        const allowed = await permission(this.client!, active.controller.signal, attached.session.id, toolCallId, String(approval.title ?? "Command"), "execute");
        if (!active.approvals.delete(id)) return;
        const server = await this.serverPromise!;
        await server.runtime.approvalResolve({ approvalId: id, input: { decision: allowed && attached.active === active && !active.controller.signal.aborted ? "accept" : "cancel" } });
      })();
      active.interactions.add(operation);
      void operation.catch(() => { active.controller.abort(); void this.interrupt(attached.session.id); }).finally(() => active.interactions.delete(operation));
    }
    if (event.name === "user_question.asked") {
      const question = SessionUserQuestionSchema.parse(record(event.data).question);
      active.question = question;
      if (this.clientCapabilities.elicitation?.form) active.answer = askQuestion(this.client!, active.controller.signal, question);
    }
  }

  private async prompt(params: acp.PromptRequest, signal: AbortSignal): Promise<acp.PromptResponse> {
    const attached = this.owned(params.sessionId);
    if (attached.active || attached.busy || this.loading.has(params.sessionId)) throw acp.RequestError.invalidRequest(undefined, "One active prompt per session is allowed.");
    const input = promptInput(params.prompt);
    let finish!: () => void, settle!: () => void;
    const active: ActivePrompt = { controller: new AbortController(), done: new Promise(resolve => { finish = resolve; }), finish: () => finish(), turnId: null,
      settlement: new Promise(resolve => { settle = resolve; }), settle: () => settle(), updates: Promise.resolve(), interactions: new Set(), approvals: new Set(), tools: new Set() };
    attached.active = active;
    const abort = () => { void this.cancel(params.sessionId); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await this.validateIdentity(attached);
      const server = await this.server();
      if (active.controller.signal.aborted) return { stopReason: "cancelled" };
      let turn: Turn;
      let turnInput = input;
      // Conversational answers remain supported when the client has no elicitation UI.
      const history = SnapshotSchema.parse(await server.runtime.threadRead({ threadId: params.sessionId }));
      const unresolved = pendingQuestion(history.events as RuntimeEvent[]);
      if (unresolved) turnInput = { ...input, metadata: { userQuestionResolution: { questionId: unresolved.id, action: "answer", text: input.prompt, optionId: unresolved.options.find(option => option.id === input.prompt.trim())?.id ?? null } } };
      do {
        active.turnId = null;
        active.question = undefined;
        active.answer = undefined;
        active.settlement = new Promise(resolve => { active.settle = resolve; });
        const result = await server.runtime.turnStart({ threadId: params.sessionId, input: { ...turnInput, modelRef: attached.session.modelRef } });
        turn = TurnSchema.parse(record(result).turn);
        active.turnId ??= turn.id;
        if (active.controller.signal.aborted) await this.interrupt(params.sessionId);
        if (turn.status === "in_progress") { await active.settlement; const state = SnapshotSchema.parse(await server.runtime.threadRead({ threadId: params.sessionId })); turn = TurnSchema.parse(state.turns.find(value => TurnSchema.parse(value).id === turn.id)); }
        await active.updates;
        const answer = await this.answer(active);
        if (!answer || active.controller.signal.aborted) break;
        turnInput = SendTurnRequestSchema.parse({ prompt: answer.action === "answer" ? answer.text || `Selected ${answer.optionId}` : "The user dismissed the question.", metadata: { userQuestionResolution: answer } });
      } while (!active.controller.signal.aborted);
      await Promise.allSettled([...active.interactions]);
      await active.updates;
      if (active.controller.signal.aborted || turn.status === "interrupted") return { stopReason: "cancelled" };
      if (turn.status === "failed") throw acp.RequestError.internalError(undefined, turn.error ?? "OpenPond turn failed.");
      return { stopReason: "end_turn" };
    } catch (error) {
      if (active.controller.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      active.controller.abort();
      await this.cancelApprovals(active);
      if (attached.active === active) attached.active = undefined;
      active.finish();
    }
  }

  private async answer(active: ActivePrompt): Promise<SessionUserQuestionResolution | null> { return active.answer ? await active.answer : null; }

  private async cancelApprovals(active: ActivePrompt): Promise<void> {
    if (!this.serverPromise) return;
    const server = await this.serverPromise;
    await Promise.allSettled([...active.approvals].map(async id => { active.approvals.delete(id); await server.runtime.approvalResolve({ approvalId: id, input: { decision: "cancel" } }); }));
  }
  private async interrupt(id: string): Promise<void> {
    if (!this.serverPromise) return;
    const server = await this.serverPromise;
    await server.runtime.turnInterrupt({ threadId: id, reason: "ACP client cancelled the prompt." }).catch(() => undefined);
  }
  private async cancel(id: string): Promise<void> {
    const active = this.sessions.get(id)?.active;
    if (!active) return;
    active.controller.abort();
    await this.cancelApprovals(active);
    await this.interrupt(id);
  }
  close(): Promise<void> {
    return this.closing ??= this.closeOwned();
  }
  private async closeOwned(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.sessions.keys()].map(id => this.cancel(id)));
    await Promise.allSettled([...this.pendingMcp].map(mcp => mcp.close()));
    await Promise.allSettled([...this.sessions.values()].flatMap(attached => attached.active ? [attached.active.done] : []));
    const server = await this.serverPromise?.catch(() => null);
    this.unsubscribe?.();
    await Promise.allSettled([...this.sessions.values()].map(attached => attached.mcp.close()));
    this.sessions.clear();
    await server?.close();
  }
}

function pendingQuestion(events: RuntimeEvent[]): SessionUserQuestion | undefined {
  const resolved = new Set(events.filter(event => event.name === "user_question.answered" || event.name === "user_question.dismissed").map(event => record(record(event.data).resolution).questionId));
  for (const event of [...events].reverse()) if (event.name === "user_question.asked") {
    const question = SessionUserQuestionSchema.parse(record(event.data).question);
    if (!resolved.has(question.id)) return question;
  }
  return undefined;
}
