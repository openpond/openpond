import { join } from "node:path";
import { AcpClient, type AcpObject, type AcpSessionResult } from "@openpond/agent-runtime";
import type { Session, Turn } from "@openpond/contracts";
import type { TurnRunnerDependencies } from "../turns/ports.js";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { event } from "../../utils.js";
import { isNativeAgentId, nativeAgentLaunch } from "./config.js";
import { nativeAgentEvent } from "./events.js";
import { createNativeAgentApprovals } from "./approvals.js";

type RunningSession = { client: AcpClient; native: AcpSessionResult; instanceId: string; cwd: string; turnId: string | null; replaying: boolean; session: Session };
export function createNativeAgentRuntime(deps: Pick<TurnRunnerDependencies, "storageHome" | "updateSession" | "appendRuntimeEvent" | "upsertApproval">) {
  const runtimes = new Map<string, RunningSession>();
  const approvals = createNativeAgentApprovals(deps);
  async function ensure(session: Session, cwd: string): Promise<RunningSession> {
    if (!isNativeAgentId(session.provider)) throw new Error("Not a native ACP provider.");
    if (!deps.storageHome) throw new Error("Native agents require a local server storage home.");
    const file = await readProvidersFile(join(deps.storageHome, "providers.json"));
    const config = file.providers[session.provider];
    if (!config?.enabled) throw new Error("Enable this agent in Providers before starting a native chat.");
    const launch = nativeAgentLaunch(session.provider, config);
    const existing = runtimes.get(session.id);
    if (existing && existing.instanceId === launch.instanceId && existing.cwd === cwd) return existing;
    if (existing) { runtimes.delete(session.id); await existing.client.stop(); }
    if (session.nativeAgent && (session.nativeAgent.provider !== session.provider || session.nativeAgent.instanceId !== launch.instanceId || session.nativeAgent.cwd !== cwd)) {
      throw new Error("Native session belongs to a different agent account/configuration or workspace. Restore its original configuration to continue.");
    }
    let runtime: RunningSession | null = null;
    const client = new AcpClient({ ...launch, cwd,
      onUpdate: async (_nativeSessionId, update) => {
        if (!runtime || runtime.replaying || !runtime.turnId) return;
        const normalized = nativeAgentEvent(runtime.session, runtime.turnId, update);
        if (normalized) await deps.appendRuntimeEvent(normalized);
      },
      onPermission: async (request, signal) => runtime?.turnId && !runtime.replaying
        ? approvals.request(session.id, runtime.turnId, request, signal)
        : { outcome: { outcome: "cancelled" } },
      onExit: () => { if (runtimes.get(session.id)?.client === client) runtimes.delete(session.id); },
    });
    try {
      const info = await client.initialize();
      if (session.provider === "grok-build" && info.authMethods?.some((method) => method.id === "cached_token")) await client.authenticate("cached_token");
      const native = session.nativeAgent
        ? await client.loadSession(session.nativeAgent.sessionId, cwd)
        : await client.createSession(cwd);
      const updated = await deps.updateSession(session.id, { nativeAgent: { provider: session.provider, instanceId: launch.instanceId, sessionId: native.sessionId, cwd } });
      runtime = { client, native, instanceId: launch.instanceId, cwd, turnId: null, replaying: false, session: updated };
      runtimes.set(session.id, runtime);
      await deps.appendRuntimeEvent(event({ sessionId: session.id, name: "diagnostic", action: "native_configuration", source: "provider", data: { provider: session.provider, nativeSessionId: native.sessionId, capabilities: info.agentCapabilities, models: native.models, modes: native.modes, configOptions: native.configOptions } }));
      return runtime;
    } catch (error) { await client.stop(); throw error; }
  }
  return {
    resolveApproval: approvals.resolve,
    async run(input: { session: Session; turn: Turn; cwd: string; prompt: string; model?: string | null; mode?: string | null; signal: AbortSignal; content?: AcpObject[] }): Promise<string> {
      const runtime = await ensure(input.session, input.cwd);
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
    async close(): Promise<void> { const active = [...runtimes.values()]; runtimes.clear(); await Promise.allSettled(active.map((runtime) => runtime.client.stop())); },
  };
}
