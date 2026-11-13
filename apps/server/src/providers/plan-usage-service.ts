import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "@openpond/codex-provider";
import type { PlanUsageProvider, ProviderConfig, ProviderPlanUsage } from "@openpond/contracts";
import { ProviderPlanUsageSchema } from "@openpond/contracts";
import { readCache, writeCache } from "@openpond/persistence";
import { nativeAgentLaunch } from "../runtime/native-agents/config.js";
import { readClaudePlanCredentials } from "./claude-plan-credentials.js";
import { claudeUsageWindows, codexUsageWindows, record } from "./plan-usage-normalization.js";

type UsageResult = Pick<ProviderPlanUsage, "status" | "windows" | "message">;
type PreparedRead = { key: string; persistent?: boolean; read: () => Promise<UsageResult> };
const unavailable = (message: string): UsageResult => ({ status: "unavailable", windows: [], message });
const signedOut = (message: string): UsageResult => ({ status: "signed_out", windows: [], message });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createPlanUsageService(options: {
  prepare?: (provider: PlanUsageProvider, config?: Partial<ProviderConfig>) => Promise<PreparedRead>;
  now?: () => number;
  home?: string;
} = {}) {
  const now = options.now ?? Date.now;
  const prepare = options.prepare ?? prepareUsageRead;
  const cache = new Map<PlanUsageProvider, { key: string; value: ProviderPlanUsage }>();
  const pending = new Map<string, Promise<ProviderPlanUsage>>();
  async function retained(provider: PlanUsageProvider, prepared: PreparedRead): Promise<ProviderPlanUsage | undefined> {
    if (prepared.persistent === false) return;
    const prior = cache.get(provider);
    if (prior?.key === prepared.key) return prior.value;
    if (!options.home) return;
    const stored = await readCache(options.home, "provider-plan-usage", hash(`${provider}:${prepared.key}`), { allowStale: true }).catch(() => null);
    const parsed = ProviderPlanUsageSchema.safeParse(stored?.payload);
    if (parsed.success && parsed.data.provider === provider) {
      cache.set(provider, { key: prepared.key, value: parsed.data });
      return parsed.data;
    }
  }
  const readUsage = async (provider: PlanUsageProvider, config?: Partial<ProviderConfig>): Promise<ProviderPlanUsage> => {
    const ttl = provider === "claude-code" ? 300_000 : 60_000;
    const snapshot = (result: UsageResult): ProviderPlanUsage => ({ provider, ...result, fetchedAt: new Date(now()).toISOString(), refreshAfter: new Date(now() + ttl).toISOString() });
    let prepared: PreparedRead;
    try { prepared = await prepare(provider, config); }
    catch { return snapshot(unavailable("Could not read the local provider login. Check the connection and try again.")); }
    const prior = await retained(provider, prepared);
    if (prior && Date.parse(prior.refreshAfter) > now()) return prior;
    const key = `${provider}:${prepared.key}`;
    const active = pending.get(key);
    if (active) return active;
    const operation = prepared.read().catch(() => unavailable("Usage is temporarily unavailable. It will refresh automatically.")).then(async result => {
      // A native login can change while the provider request is in flight.
      const current = await prepare(provider, config).catch(() => null);
      if (!current || current.key !== prepared.key) return snapshot(unavailable("Provider login changed. Usage will refresh automatically."));
      const value = result.status === "unavailable" && prior?.status === "ready"
        ? { ...prior, message: result.message, refreshAfter: new Date(now() + ttl).toISOString() }
        : snapshot(result);
      cache.set(provider, { key: prepared.key, value });
      if (options.home && prepared.persistent !== false) await writeCache(options.home, "provider-plan-usage", hash(key), value, { ttlMs: ttl }).catch(() => undefined);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
  return Object.assign(readUsage, { cached: async (provider: PlanUsageProvider, config?: Partial<ProviderConfig>) => {
    const prepared = await prepare(provider, config).catch(() => null);
    return prepared ? retained(provider, prepared) : undefined;
  } });
}

async function prepareUsageRead(provider: PlanUsageProvider, config?: Partial<ProviderConfig>): Promise<PreparedRead> {
  if (provider === "claude-code") {
    const launch = nativeAgentLaunch(provider, config);
    const credentials = await readClaudePlanCredentials(launch);
    return {
      key: `${launch.instanceId}:${hash(credentials?.token ?? "signed-out")}:${credentials?.expiresAt !== null && credentials?.expiresAt !== undefined && credentials.expiresAt <= Date.now() ? "expired" : "current"}`,
      read: async () => {
        if (!credentials) return signedOut("Sign in to a Claude subscription using Claude Code to see plan usage.");
        if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) return signedOut("Open Claude Code to renew your login, then refresh usage.");
        const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: { Authorization: `Bearer ${credentials.token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
          signal: AbortSignal.timeout(10_000), redirect: "error",
        });
        if (response.status === 401) return signedOut("Open Claude Code to renew your login, then refresh usage.");
        if (response.status === 403) return { status: "unsupported", windows: [], message: "Plan usage is not available for this Claude login." };
        if (response.status === 429) return unavailable("Claude is limiting usage checks. Retrying in five minutes.");
        if (!response.ok) return unavailable("Claude usage is temporarily unavailable.");
        const windows = claudeUsageWindows(await response.json());
        return windows.length ? { status: "ready", windows, message: null } : { status: "unsupported", windows: [], message: "Claude did not report any plan usage windows for this account." };
      },
    };
  }
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  // Credential contents never leave this process. Changes invalidate account-scoped cache entries.
  const identity = await readFile(join(home, "auth.json"), "utf8").then(hash).catch(() => null);
  return { key: `${config?.binaryPath || "codex"}:${home}:${identity ?? "native-login"}`, persistent: identity !== null, read: () => readCodexUsage(config?.binaryPath ?? undefined) };
}

async function readCodexUsage(binaryPath?: string): Promise<UsageResult> {
  const client = new CodexAppServerClient({ binaryPath, clientName: "openpond-plan-usage", clientTitle: "OpenPond Plan Usage" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Start before installing the deadline so cleanup cannot race a late spawn.
    await client.start();
    return await Promise.race([
      (async (): Promise<UsageResult> => {
        const account = record(record(await client.readAccount()).account);
        if (!account.type) return signedOut("Sign in to Codex to see plan usage.");
        if (account.type === "apiKey") return { status: "unsupported", windows: [], message: "API key billing does not include subscription plan percentages." };
        const windows = codexUsageWindows(await client.readRateLimits());
        return windows.length ? { status: "ready", windows, message: null } : { status: "unsupported", windows: [], message: "Codex did not report any plan usage windows for this account." };
      })(),
      new Promise<UsageResult>((_, reject) => { timer = setTimeout(() => reject(new Error("Usage check timed out")), 15_000); }),
    ]);
  } finally { clearTimeout(timer); await client.stop(); }
}
