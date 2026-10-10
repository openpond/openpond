import { acpSessionCatalog } from "./session-controls.js";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient } from "@openpond/agent-runtime/acp/client";
import { ClaudeCliClient } from "@openpond/agent-runtime/acp/claude-cli-client";
import { type AcpSessionResult } from "@openpond/agent-runtime/acp/types";
import { ProviderModelSchema, isRegisteredAcpProvider, type ProviderSettings, type ProviderConfig } from "@openpond/contracts/providers";
import { isNativeAgentId, NATIVE_AGENTS, nativeAgentLaunch, type NativeAgentId } from "./config.js";
import { createNativeCapabilityProbe } from "./capability-probes.js";

export type NativeAgentSetupResult = {
  provider: NativeAgentId;
  status: "ready" | "missing" | "unavailable" | "needs_login";
  instanceId: string;
  version: string | null;
  error: string | null;
  installUrl: string;
  loginCommand: string[];
  authMethods: Array<{ id: string; name: string; description?: string; type?: string }>;
  capabilities: import("@openpond/agent-runtime").AcpInitializeResult["agentCapabilities"] | null;
  session: AcpSessionResult | null;
};
const cache = new Map<string, { result: NativeAgentSetupResult; expires: number }>();
const probing = new Map<string, Promise<NativeAgentSetupResult>>();

export async function probeNativeAgent(provider: NativeAgentId, config?: Partial<ProviderConfig>, options: { force?: boolean; authMethodId?: string; signal?: AbortSignal } = {}): Promise<NativeAgentSetupResult> {
  const launch = nativeAgentLaunch(provider, config);
  const prior = cache.get(launch.instanceId);
  if (!options.force && !options.authMethodId && prior && prior.expires > Date.now()) return prior.result;
  const active = probing.get(launch.instanceId);
  if (active && !options.signal) return active;
  const operation = (async () => {
    const definition = isRegisteredAcpProvider(provider) ? { installUrl: config?.acp?.installUrl ?? "", login: [] } : NATIVE_AGENTS[provider];
    const result: NativeAgentSetupResult = { provider, status: "unavailable", instanceId: launch.instanceId, version: null, error: null, installUrl: definition.installUrl, loginCommand: definition.login, authMethods: [], capabilities: null, session: null };
    const Client = provider === "claude-code" ? ClaudeCliClient : AcpClient;
    const client = new Client({ ...launch, cwd: homedir(), requestTimeoutMs: options.authMethodId ? 180_000 : 15_000 });
    const deadline = AbortSignal.timeout(options.authMethodId ? 180_000 : 40_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= client.stop();
    const abort = () => { void stop(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const info = await client.initialize();
      if (provider === "claude-code") {
        let stdout: string;
        let signedOutExit = false;
        try {
          ({ stdout } = await promisify(execFile)(launch.command, ["auth", "status", "--json"], { env: launch.env, signal, timeout: 10_000, maxBuffer: 64 * 1024 }));
        } catch (error) {
          // The native CLI reports an ordinary signed-out state with exit 1
          // and a JSON body. Preserve spawn/timeout failures as unavailable.
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== 1 || !("stdout" in error) || typeof error.stdout !== "string") throw error;
          stdout = error.stdout;
          signedOutExit = true;
        }
        let auth: { loggedIn?: boolean } | null;
        try { auth = JSON.parse(stdout); }
        catch { throw new Error("Claude Code returned an unsupported authentication status."); }
        if (!auth || typeof auth.loggedIn !== "boolean" || (signedOutExit && auth.loggedIn)) throw new Error("Claude Code returned an unsupported authentication status.");
        if (!auth.loggedIn) { result.status = "needs_login"; throw new Error("Sign in using Claude Code's native login, then reconnect."); }
        const version = await promisify(execFile)(launch.command, ["--version"], { env: launch.env, signal, timeout: 10_000, maxBuffer: 4096 });
        result.version = version.stdout.trim().slice(0, 200);
      }
      result.version ??= info.agentInfo?.version ?? null;
      result.authMethods = info.authMethods ?? [];
      result.capabilities = info.agentCapabilities ?? null;
      const authMethodId = options.authMethodId ?? config?.acp?.authMethodId;
      if (authMethodId) await client.authenticate(authMethodId);
      else if (provider === "grok-build" && info.authMethods?.some((method) => method.id === "cached_token")) await client.authenticate("cached_token");
      signal.throwIfAborted();
      result.session = acpSessionCatalog(await createNativeCapabilityProbe(provider, launch.sourceHome, () => client.createSession(homedir())));
      signal.throwIfAborted();
      result.status = "ready";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      result.status = code === "ENOENT" ? "missing" : result.status === "needs_login" || (code === -32000 && error instanceof Error && error.message === "Authentication required") ? "needs_login" : "unavailable";
      result.error = error instanceof Error ? error.message : "Native agent connection failed.";
    } finally { signal.removeEventListener("abort", abort); await stop(); }
    if (signal.aborted) throw signal.reason;
    cache.set(launch.instanceId, { result, expires: Date.now() + (result.status === "ready" ? 300_000 : 30_000) });
    return result;
  })();
  if (!options.signal) probing.set(launch.instanceId, operation);
  try { return await operation; } finally { if (probing.get(launch.instanceId) === operation) probing.delete(launch.instanceId); }
}

export function invalidateNativeAgent(instanceId: string, error: Error): void {
  const cached = cache.get(instanceId);
  if (cached) cache.set(instanceId, { expires: 0, result: { ...cached.result, status: "unavailable", error: error.message } });
}

export async function applyNativeAgentStatus(settings: ProviderSettings): Promise<ProviderSettings> {
  // A configured native agent remains discoverable after a server restart;
  // opening its setup dialog is not a prerequisite for desktop orchestration.
  await Promise.all(Object.entries(settings.providers).map(async ([id, config]) => {
    if (config.enabled && isNativeAgentId(id))
      await probeNativeAgent(id, config).catch(() => undefined);
  }));
  for (const [id, config] of Object.entries(settings.providers)) {
    if (!isNativeAgentId(id)) continue;
    const status = settings.statuses[id];
    if (!status) continue;
    const cached = cache.get(nativeAgentLaunch(id, config).instanceId);
    const result = cached?.result ?? null;
    status.capabilities.imageInput = result?.capabilities?.promptCapabilities?.image === true;
    status.available = config.enabled && result?.status === "ready";
    status.credential.connected = result?.status === "ready";
    status.credential.source = result?.status === "ready" ? "native_agent_login" : "none";
    status.lastError = result?.error ?? null;
    if (result?.session?.models) {
      const models = result.session.models.availableModels.map((model) => ProviderModelSchema.parse({ id: model.modelId, providerId: id, displayName: model.name, source: "provider", capabilities: { streaming: true, toolCalling: true, vision: status.capabilities.imageInput } }));
      settings.modelCaches[id] = { providerId: id, models, fetchedAt: new Date().toISOString(), source: "provider", lastError: null };
      status.modelIds = models.map((model) => model.id);
      status.defaultModel = config.defaultModel ?? result.session.models.currentModelId;
      config.defaultModel = status.defaultModel;
    }
  }
  return settings;
}
