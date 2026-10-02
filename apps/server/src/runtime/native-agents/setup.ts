import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient, ClaudeCliClient, type AcpSessionResult } from "@openpond/agent-runtime";
import { ProviderModelSchema, type ProviderSettings, type ProviderConfig } from "@openpond/contracts";
import { isNativeAgentId, NATIVE_AGENTS, nativeAgentLaunch, type NativeAgentId } from "./config.js";

export type NativeAgentSetupResult = {
  provider: NativeAgentId;
  status: "ready" | "unavailable" | "needs_login";
  instanceId: string;
  version: string | null;
  error: string | null;
  installUrl: string;
  loginCommand: string[];
  authMethods: Array<{ id: string; name: string; description?: string; type?: string }>;
  capabilities: unknown;
  session: AcpSessionResult | null;
};
const cache = new Map<string, { result: NativeAgentSetupResult; expires: number }>();
const probing = new Map<string, Promise<NativeAgentSetupResult>>();

export async function probeNativeAgent(provider: NativeAgentId, config?: Partial<ProviderConfig>, options: { force?: boolean; authMethodId?: string } = {}): Promise<NativeAgentSetupResult> {
  const launch = nativeAgentLaunch(provider, config);
  const prior = cache.get(launch.instanceId);
  if (!options.force && !options.authMethodId && prior && prior.expires > Date.now()) return prior.result;
  const active = probing.get(launch.instanceId);
  if (active) return active;
  const operation = (async () => {
    const definition = NATIVE_AGENTS[provider];
    const result: NativeAgentSetupResult = { provider, status: "unavailable", instanceId: launch.instanceId, version: null, error: null, installUrl: definition.installUrl, loginCommand: definition.login, authMethods: [], capabilities: null, session: null };
    const Client = provider === "claude-code" ? ClaudeCliClient : AcpClient;
    const client = new Client({ ...launch, cwd: homedir(), requestTimeoutMs: 15_000 });
    try {
      const info = await client.initialize();
      if (provider === "claude-code") {
        const { stdout } = await promisify(execFile)(launch.command, ["auth", "status", "--json"], { env: launch.env, timeout: 10_000, maxBuffer: 64 * 1024 });
        const auth = JSON.parse(stdout) as { loggedIn?: boolean };
        if (!auth.loggedIn) { result.status = "needs_login"; result.error = "Sign in using Claude Code's native login, then reconnect."; return result; }
      }
      result.version = info.agentInfo?.version ?? null;
      result.authMethods = info.authMethods ?? [];
      result.capabilities = info.agentCapabilities ?? null;
      if (options.authMethodId) await client.authenticate(options.authMethodId);
      else if (provider === "grok-build" && info.authMethods?.some((method) => method.id === "cached_token")) await client.authenticate("cached_token");
      result.session = await client.createSession(homedir());
      result.status = "ready";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      result.status = code === -32000 || code === -32001 ? "needs_login" : "unavailable";
      result.error = error instanceof Error ? error.message : "Native agent connection failed.";
    } finally { await client.stop(); }
    cache.set(launch.instanceId, { result, expires: Date.now() + 30_000 });
    return result;
  })();
  probing.set(launch.instanceId, operation);
  try { return await operation; } finally { probing.delete(launch.instanceId); }
}

export function applyNativeAgentStatus(settings: ProviderSettings): ProviderSettings {
  for (const [id, config] of Object.entries(settings.providers)) {
    if (!isNativeAgentId(id)) continue;
    const status = settings.statuses[id];
    if (!status) continue;
    const cached = cache.get(nativeAgentLaunch(id, config).instanceId);
    const result = cached?.result ?? null;
    status.available = config.enabled && result?.status === "ready";
    status.credential.connected = result?.status === "ready";
    status.credential.source = result?.status === "ready" ? "native_agent_login" : "none";
    status.lastError = result?.error ?? null;
    if (result?.session?.models) {
      const models = result.session.models.availableModels.map((model) => ProviderModelSchema.parse({ id: model.modelId, providerId: id, displayName: model.name, source: "provider", capabilities: { streaming: true, toolCalling: true } }));
      settings.modelCaches[id] = { providerId: id, models, fetchedAt: new Date().toISOString(), source: "provider", lastError: null };
      status.modelIds = models.map((model) => model.id);
      status.defaultModel = config.defaultModel ?? result.session.models.currentModelId;
      config.defaultModel = status.defaultModel;
    }
  }
  return settings;
}
