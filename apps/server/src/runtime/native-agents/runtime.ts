import { join } from "node:path";
import { AcpClient, ClaudeCliClient, type AcpObject, type AcpSessionResult } from "@openpond/agent-runtime";
import type { Session, Turn } from "@openpond/contracts";
import type { TurnRunnerDependencies } from "../turns/ports.js";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { event } from "../../utils.js";
import { isNativeAgentId, nativeAgentLaunch } from "./config.js";
import { nativeAgentEvent } from "./events.js";
import { createNativeAgentApprovals } from "./approvals.js";
import { createTaskCoordinationMcp, type TaskCoordinationBridge } from "../task-inbox/codex-mcp.js";

type RunningSession = { client: AcpClient | ClaudeCliClient; native: AcpSessionResult; instanceId: string; cwd: string; turnId: string | null; replaying: boolean; session: Session; coordinated: boolean; close(): Promise<void> };
export function createNativeAgentRuntime(deps: Pick<TurnRunnerDependencies, "storageHome" | "updateSession" | "appendRuntimeEvent" | "upsertApproval">) {
  const runtimes = new Map<string, RunningSession>();
  const approvals = createNativeAgentApprovals(deps);
  async function ensure(session: Session, cwd: string, coordination?: TaskCoordinationBridge): Promise<RunningSession> {
    if (!isNativeAgentId(session.provider)) throw new Error("Not a native ACP provider.");
    if (session.metadata?.nativeHistoryProjection && !session.nativeAgent) throw new Error("This retained conversation has no qualified native resume reference. It is available for inspection only.");
    if (!deps.storageHome) throw new Error("Native agents require a local server storage home.");
    const file = await readProvidersFile(join(deps.storageHome, "providers.json"));
    const config = file.providers[session.provider];
    if (!config?.enabled) throw new Error("Enable this agent in Providers before starting a native chat.");
    const launch = nativeAgentLaunch(session.provider, config);
    const existing = runtimes.get(session.id);
    if (existing && existing.instanceId === launch.instanceId && existing.cwd === cwd && existing.coordinated === Boolean(coordination)) return existing;
    if (existing) { runtimes.delete(session.id); await existing.close(); }
    if (session.nativeAgent && (session.nativeAgent.provider !== session.provider || session.nativeAgent.instanceId !== launch.instanceId || session.nativeAgent.cwd !== cwd)) {
      throw new Error("Native session belongs to a different agent account/configuration or workspace. Restore its original configuration to continue.");
    }
    let runtime: RunningSession | null = null;
    const bridge = coordination ? await createTaskCoordinationMcp(coordination) : null;
    let bridgeClosing: Promise<void> | null = null;
    const closeBridge = () => bridgeClosing ??= bridge ? bridge.close() : Promise.resolve();
    const Client = session.provider === "claude-code" ? ClaudeCliClient : AcpClient;
    const client = new Client({ ...launch, cwd,
      onUpdate: async (_nativeSessionId, update) => {
        if (!runtime || runtime.replaying || !runtime.turnId) return;
        const normalized = nativeAgentEvent(runtime.session, runtime.turnId, update);
        if (normalized) await deps.appendRuntimeEvent(normalized);
      },
      onPermission: async (request, signal) => runtime?.turnId && !runtime.replaying
        ? approvals.request(session.id, runtime.turnId, request, signal)
        : { outcome: { outcome: "cancelled" } },
      onExit: () => { if (runtimes.get(session.id)?.client === client) runtimes.delete(session.id); void closeBridge().catch(() => undefined); },
    });
    try {
      const info = await client.initialize();
      if (bridge && !info.agentCapabilities?.mcpCapabilities?.http) throw new Error("This native agent does not advertise HTTP MCP support required for OpenPond task tools.");
      const servers = bridge ? [{ type: "http", name: "openpond_task", url: bridge.config.url, headers: Object.entries(bridge.config.http_headers).map(([name, value]) => ({ name, value })) }] : [];
      if (session.provider === "grok-build" && info.authMethods?.some((method) => method.id === "cached_token")) await client.authenticate("cached_token");
      const native = session.nativeAgent
        ? await client.loadSession(session.nativeAgent.sessionId, cwd, servers)
        : await client.createSession(cwd, servers);
      const updated = await deps.updateSession(session.id, { nativeAgent: { provider: session.provider, instanceId: launch.instanceId, sessionId: native.sessionId, cwd }, metadata: { ...session.metadata, nativeHistoryProjection: false } });
      runtime = { client, native, instanceId: launch.instanceId, cwd, turnId: null, replaying: false, session: updated, coordinated: Boolean(bridge), close: async () => { await client.stop(); await closeBridge(); } };
      runtimes.set(session.id, runtime);
      await deps.appendRuntimeEvent(event({ sessionId: session.id, name: "diagnostic", action: "native_configuration", source: "provider", data: { provider: session.provider, nativeSessionId: native.sessionId, capabilities: info.agentCapabilities, models: native.models, modes: native.modes, configOptions: native.configOptions } }));
      return runtime;
    } catch (error) { await client.stop(); await closeBridge(); throw error; }
  }
  return {
    resolveApproval: approvals.resolve,
    async run(input: { session: Session; turn: Turn; cwd: string; prompt: string; model?: string | null; mode?: string | null; signal: AbortSignal; content?: AcpObject[]; coordination?: TaskCoordinationBridge }): Promise<string> {
      const runtime = await ensure(input.session, input.cwd, input.coordination);
      if (runtime.turnId) throw new Error("Native conversation already has an active turn.");
      runtime.turnId = input.turn.id;
      try {
        if (input.model && input.model !== runtime.native.models?.currentModelId) {
          if (!runtime.native.models?.availableModels.some((model) => model.modelId === input.model)) throw new Error("Selected model is not advertised by this agent session.");
          await runtime.client.setModel(runtime.native.sessionId, input.model);
          runtime.native.models.currentModelId = input.model;
        }
        if (input.mode) {
          if (!runtime.native.modes?.availableModes.some((mode) => mode.id === input.mode)) throw new Error("Selected mode is not advertised by this agent session.");
          await runtime.client.setMode(runtime.native.sessionId, input.mode);
        }
        const result = await runtime.client.prompt(runtime.native.sessionId, [{ type: "text", text: input.prompt }, ...(input.content ?? [])], input.signal);
        if (input.signal.aborted || result.stopReason === "cancelled") throw new Error("Native agent turn interrupted.");
        if (result.stopReason === "refusal") throw new Error("Native agent declined the request.");
        return `${runtime.native.sessionId}:${input.turn.id}`;
      } finally { runtime.turnId = null; }
    },
    async close(): Promise<void> { const active = [...runtimes.values()]; runtimes.clear(); await Promise.allSettled(active.map((runtime) => runtime.close())); },
  };
}
