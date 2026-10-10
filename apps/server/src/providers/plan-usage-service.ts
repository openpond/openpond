import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "@openpond/codex-provider";
import type { PlanUsageProvider, ProviderConfig, ProviderPlanUsage } from "@openpond/contracts";
import { nativeAgentLaunch } from "../runtime/native-agents/config.js";
import { readClaudePlanCredentials } from "./claude-plan-credentials.js";
import { claudeUsageWindows, codexUsageWindows, record } from "./plan-usage-normalization.js";

type UsageResult = Pick<ProviderPlanUsage, "status" | "windows" | "message">;
type PreparedRead = { key: string; read: () => Promise<UsageResult> };
const unavailable = (message: string): UsageResult => ({ status: "unavailable", windows: [], message });
const signedOut = (message: string): UsageResult => ({ status: "signed_out", windows: [], message });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createPlanUsageService(options: {
  prepare?: (provider: PlanUsageProvider, config?: Partial<ProviderConfig>) => Promise<PreparedRead>;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const prepare = options.prepare ?? prepareUsageRead;
  const cache = new Map<PlanUsageProvider, { key: string; value: ProviderPlanUsage }>();
  const pending = new Map<string, Promise<ProviderPlanUsage>>();
  return async (provider: PlanUsageProvider, config?: Partial<ProviderConfig>): Promise<ProviderPlanUsage> => {
    const ttl = provider === "claude-code" ? 300_000 : 60_000;
    const snapshot = (result: UsageResult): ProviderPlanUsage => ({ provider, ...result, fetchedAt: new Date(now()).toISOString(), refreshAfter: new Date(now() + ttl).toISOString() });
    let prepared: PreparedRead;
    try { prepared = await prepare(provider, config); }
    catch { return snapshot(unavailable("Could not read the local provider login. Check the connection and try again.")); }
    const prior = cache.get(provider);
    if (prior?.key === prepared.key && Date.parse(prior.value.refreshAfter) > now()) return prior.value;
    const key = `${provider}:${prepared.key}`;
    const active = pending.get(key);
    if (active) return active;
    const operation = prepared.read().catch(() => unavailable("Usage is temporarily unavailable. It will refresh automatically.")).then(result => {
      const value = snapshot(result);
      cache.set(provider, { key: prepared.key, value });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}

async function prepareUsageRead(provider: PlanUsageProvider, config?: Partial<ProviderConfig>): Promise<PreparedRead> {
  if (provider === "claude-code") {
    const launch = nativeAgentLaunch(provider, config);
    const credentials = await readClaudePlanCredentials(launch);
    return {
      key: `${launch.instanceId}:${hash(credentials?.token ?? "signed-out")}`,
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
  const identity = await readFile(join(home, "auth.json"), "utf8").then(hash).catch(() => "native-login");
  return { key: `${config?.binaryPath || "codex"}:${home}:${identity}`, read: () => readCodexUsage(config?.binaryPath ?? undefined) };
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
