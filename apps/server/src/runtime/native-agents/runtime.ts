import { acpCategoryOption, acpSelectValues, acpSessionModels, acpSessionModes } from "./session-controls.js";
import { createProviderRequestUsageRecord } from "../model-usage-recorder.js";
import { createSafeModelUsagePersistence } from "../turns/model-usage-persistence.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AcpClient } from "@openpond/agent-runtime/acp/client";
import { ClaudeCliClient } from "@openpond/agent-runtime/acp/claude-cli-client";
import { type AcpObject, type AcpSessionResult } from "@openpond/agent-runtime/acp/types";
import type { Session, Turn } from "@openpond/contracts";
import type { TurnRunnerDependencies } from "../turns/ports.js";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { event } from "../../utils.js";
import { findLocalProject } from "../../workspace/local-projects.js";
import { isNativeAgentId, nativeAgentLaunch } from "./config.js";
import { nativeAgentEvent } from "./events.js";
import { invalidateNativeAgent } from "./setup.js";
import { createNativeAgentApprovals } from "./approvals.js";
import { createTaskCoordinationMcp, type TaskCoordinationBridge } from "../task-inbox/codex-mcp.js";

type RunningSession = { requestId: string; requestOrdinal: number; turn: Turn | null; startedAt: string; firstTokenMs: number | null; visibleUpdates: number; imageInput: boolean; client: AcpClient | ClaudeCliClient; native: AcpSessionResult; instanceId: string; cwd: string; additionalDirectories: string[]; turnId: string | null; replaying: boolean; session: Session; coordinated: boolean; taskTools: boolean; close(): Promise<void> };
export function createNativeAgentRuntime(deps: Pick<TurnRunnerDependencies, "store" | "storageHome" | "updateSession" | "appendRuntimeEvent" | "upsertApproval">) {
  const runtimes = new Map<string, RunningSession>();
  const approvals = createNativeAgentApprovals(deps);
  const persistUsage = createSafeModelUsagePersistence({ upsert: deps.store.upsertModelUsageRecord?.bind(deps.store), appendRuntimeEvent: deps.appendRuntimeEvent });
  async function ensure(session: Session, cwd: string, coordination?: TaskCoordinationBridge): Promise<RunningSession> {
    if (!isNativeAgentId(session.provider)) throw new Error("Not a native ACP provider.");
    if (session.metadata?.nativeHistoryProjection && !session.nativeAgent) throw new Error("This retained conversation has no qualified native resume reference. It is available for inspection only.");
    if (!deps.storageHome) throw new Error("Native agents require a local server storage home.");
    const file = await readProvidersFile(join(deps.storageHome, "providers.json"));
    const config = file.providers[session.provider];
    if (!config?.enabled) throw new Error("Enable this agent in Providers before starting a native chat.");
    const launch = nativeAgentLaunch(session.provider, config);
    const project = session.workspaceKind === "local_project" && session.workspaceId
      ? await findLocalProject({ home: deps.storageHome }, session.workspaceId)
      : null;
    const additionalDirectories = session.provider === "claude-code"
      ? [...new Set(project?.sourceFolders?.filter((folder) => folder !== cwd) ?? [])].sort()
      : [];
    const existing = runtimes.get(session.id);
    if (existing && existing.instanceId === launch.instanceId && existing.cwd === cwd && JSON.stringify(existing.additionalDirectories) === JSON.stringify(additionalDirectories) && existing.coordinated === Boolean(coordination)) return existing;
    if (existing) { runtimes.delete(session.id); await existing.close(); }
    if (session.nativeAgent && (session.nativeAgent.provider !== session.provider || session.nativeAgent.instanceId !== launch.instanceId || session.nativeAgent.cwd !== cwd)) {
      throw new Error("Native session belongs to a different agent account/configuration or workspace. Restore its original configuration to continue.");
    }
    let runtime: RunningSession | null = null;
    const bridge = coordination ? await createTaskCoordinationMcp(coordination) : null;
    let bridgeClosing: Promise<void> | null = null;
    const closeBridge = () => bridgeClosing ??= bridge ? bridge.close() : Promise.resolve();
    const Client = session.provider === "claude-code" ? ClaudeCliClient : AcpClient;
    const client = new Client({ ...launch, cwd, additionalDirectories,
      onUpdate: async (_nativeSessionId, update) => {
        if (!runtime) return;
        if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) runtime.native.configOptions = update.configOptions as AcpObject[];
        if (update.sessionUpdate === "current_mode_update" && runtime.native.modes && typeof update.currentModeId === "string") runtime.native.modes.currentModeId = update.currentModeId;
        if (runtime.replaying || !runtime.turnId) return;
        if (runtime.firstTokenMs === null && ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(String(update.sessionUpdate))) runtime.firstTokenMs = Math.max(0, Date.now() - Date.parse(runtime.startedAt));
        if (update.sessionUpdate === "usage_update" && runtime.session.provider === "claude-code") {
          await persistUsage(createProviderRequestUsageRecord({ session: runtime.session, turn: runtime.turn,
            provider: runtime.session.provider, model: typeof update.model === "string" ? update.model : "unknown",
            requestId: runtime.requestId, requestOrdinal: runtime.requestOrdinal,
            startedAt: runtime.startedAt, completedAt: new Date().toISOString(), firstTokenMs: runtime.firstTokenMs,
            usage: update.usage, status: update.status === "failed" ? "failed" : update.status === "interrupted" ? "interrupted" : "completed" }));
        }
        const normalized = nativeAgentEvent(runtime.session, runtime.turnId, update);
        if (normalized && ["assistant.delta", "assistant.reasoning.delta", "tool.started", "tool.completed"].includes(normalized.name)) runtime.visibleUpdates++;
        if (normalized) await deps.appendRuntimeEvent(normalized);
      },
      onPermission: async (request, signal) => runtime?.turnId && !runtime.replaying
        ? approvals.request(session.id, runtime.turnId, request, signal)
        : { outcome: { outcome: "cancelled" } },
      onExit: (error) => { if (runtimes.get(session.id)?.client === client) { runtimes.delete(session.id); invalidateNativeAgent(launch.instanceId, error); } void closeBridge().catch(() => undefined); },
    });
    try {
      const info = await client.initialize();
      const taskTools = Boolean(bridge && info.agentCapabilities?.mcpCapabilities?.http);
      if (bridge && !taskTools) {
        await closeBridge();
        await deps.appendRuntimeEvent(event({ sessionId: session.id, name: "diagnostic", action: "native_capabilities", source: "provider", output: "This ACP agent does not support HTTP MCP. OpenPond task tools are unavailable for this connection." }));
      }
      const servers = taskTools && bridge ? [{ type: "http", name: "openpond_task", url: bridge.config.url, headers: Object.entries(bridge.config.http_headers).map(([name, value]) => ({ name, value })) }] : [];
      if (config.acp?.authMethodId) await client.authenticate(config.acp.authMethodId);
      else if (session.provider === "grok-build" && info.authMethods?.some((method) => method.id === "cached_token")) await client.authenticate("cached_token");
      const native = session.nativeAgent
        ? await client.loadSession(session.nativeAgent.sessionId, cwd, servers)
        : await client.createSession(cwd, servers);
      const updated = await deps.updateSession(session.id, { nativeAgent: { provider: session.provider, instanceId: launch.instanceId, sessionId: native.sessionId, cwd }, metadata: { ...session.metadata, nativeHistoryProjection: false, ...(config.acp ? { acpAgentName: config.acp.displayName } : {}) } });
      runtime = { requestId: "", requestOrdinal: 0, turn: null, startedAt: "", firstTokenMs: null, visibleUpdates: 0, imageInput: info.agentCapabilities?.promptCapabilities?.image === true, client, native, instanceId: launch.instanceId, cwd, additionalDirectories, turnId: null, replaying: false, session: updated, coordinated: Boolean(coordination), taskTools, close: async () => { await client.stop(); await closeBridge(); } };
      runtimes.set(session.id, runtime);
      await deps.appendRuntimeEvent(event({ sessionId: session.id, name: "diagnostic", action: "native_configuration", source: "provider", data: { provider: session.provider, nativeSessionId: native.sessionId, capabilities: info.agentCapabilities, models: native.models, modes: native.modes, configOptions: native.configOptions } }));
      return runtime;
    } catch (error) { await client.stop(); await closeBridge(); throw error; }
  }
  return {
    resolveApproval: approvals.resolve,
    async run(input: { session: Session; turn: Turn; cwd: string; prompt: string; model?: string | null; mode?: string | null; signal: AbortSignal; requestId?: string; requestOrdinal?: number; content?: AcpObject[]; coordination?: TaskCoordinationBridge; preparePrompt?: (prompt: string, capabilities: { taskTools: boolean }) => Promise<string>; settlePrompt?: (outcome: "resolved" | "failed") => Promise<void> }): Promise<string> {
      const runtime = await ensure(input.session, input.cwd, input.coordination);
      if (input.content?.some((part) => part.type === "image") && !runtime.imageInput) throw new Error("This native agent does not advertise image input. Choose a supported model/agent or attach text instead.");
      if (runtime.turnId) throw new Error("Native conversation already has an active turn.");
      runtime.turnId = input.turn.id;
      runtime.turn = input.turn;
      runtime.requestId = input.requestId ?? `native:${input.session.id}:${input.turn.id}`;
      runtime.requestOrdinal = input.requestOrdinal ?? 0;
      runtime.startedAt = new Date().toISOString();
      runtime.firstTokenMs = null;
      runtime.visibleUpdates = 0;
      try {
        const models = acpSessionModels(runtime.native);
        if (input.model && input.model !== models?.currentModelId) {
          if (!models?.availableModels.some(model => model.modelId === input.model)) throw new Error("Selected model is not advertised by this agent session.");
          const option = acpCategoryOption(runtime.native, "model");
          if (option && runtime.client instanceof AcpClient) {
            const result = await runtime.client.setConfigOption(runtime.native.sessionId, option.id as string, input.model);
            if (result.configOptions) runtime.native.configOptions = result.configOptions;
          } else {
            await runtime.client.setModel(runtime.native.sessionId, input.model);
            runtime.native.models!.currentModelId = input.model;
          }
        }
        const file = await readProvidersFile(join(deps.storageHome!, "providers.json"));
        const config = file.providers[input.session.provider];
        const selectedMode = input.mode ?? config?.nativeMode;
        if (selectedMode) {
          if (!acpSessionModes(runtime.native)?.availableModes.some(mode => mode.id === selectedMode)) throw new Error("Selected mode is not advertised by this agent session.");
          const option = acpCategoryOption(runtime.native, "mode");
          if (option && runtime.client instanceof AcpClient) {
            const result = await runtime.client.setConfigOption(runtime.native.sessionId, option.id as string, selectedMode);
            if (result.configOptions) runtime.native.configOptions = result.configOptions;
          } else await runtime.client.setMode(runtime.native.sessionId, selectedMode);
        }
        for (const [configId, value] of Object.entries(config?.nativeOptions ?? {})) {
          const option = runtime.native.configOptions?.find((candidate) => candidate.id === configId);
          const values = acpSelectValues(option);
          if (option?.category === "model" || option?.category === "mode") continue;
          if (!option || !values.some((entry) => (entry as AcpObject).value === value) || !(runtime.client instanceof AcpClient)) throw new Error("Selected setting is not advertised by this native session. Refresh its settings.");
          const result = await runtime.client.setConfigOption(runtime.native.sessionId, configId, value);
          if (result.configOptions) runtime.native.configOptions = result.configOptions;
        }
        const prompt = input.preparePrompt ? await input.preparePrompt(input.prompt, { taskTools: runtime.taskTools }) : input.prompt;
        if (input.signal.aborted) throw new Error("Native agent turn interrupted before dispatch.");
        const promptHash = createHash("sha256").update(prompt).digest("hex");
        await deps.store.updateTurn(input.turn.id, (turn) => {
          const hashes = Array.isArray(turn.metadata?.nativePromptHashes) ? turn.metadata.nativePromptHashes : [];
          return { ...turn, metadata: { ...turn.metadata, nativePromptHash: promptHash,
            nativePromptHashes: [...new Set([...hashes, promptHash])] } };
        });
        const result = await runtime.client.prompt(runtime.native.sessionId, [{ type: "text", text: prompt }, ...(input.content ?? [])], input.signal);
        if (input.signal.aborted || result.stopReason === "cancelled") throw new Error("Native agent turn interrupted.");
        if (result.stopReason === "refusal") throw new Error("Native agent declined the request.");
        if (!runtime.visibleUpdates) throw new Error("The native agent ended without a response or tool activity. Check its selected model, native login and provider status, then retry.");
        await input.settlePrompt?.("resolved");
        return `${runtime.native.sessionId}:${input.turn.id}`;
      } catch (error) {
        await input.settlePrompt?.("failed");
        throw error;
      } finally { runtime.turnId = null; runtime.turn = null; }
    },
    async close(): Promise<void> { const active = [...runtimes.values()]; runtimes.clear(); await Promise.allSettled(active.map((runtime) => runtime.close())); },
  };
}
