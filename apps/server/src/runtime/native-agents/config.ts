import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderConfig } from "@openpond/contracts";

export const NATIVE_AGENT_IDS = ["claude-code", "grok-build", "opencode"] as const;
export type NativeAgentId = typeof NATIVE_AGENT_IDS[number];
export function isNativeAgentId(value: string): value is NativeAgentId { return (NATIVE_AGENT_IDS as readonly string[]).includes(value); }
export const NATIVE_AGENTS = {
  "claude-code": { title: "Claude Code", command: "claude", args: [] as string[], installUrl: "https://code.claude.com/docs/en/setup", login: ["claude", "auth", "login"], homeVariable: "CLAUDE_CONFIG_DIR", defaultHome: () => join(homedir(), ".claude") },
  "grok-build": { title: "Grok Build", command: "grok", args: ["--no-auto-update", "agent", "stdio"], installUrl: "https://docs.x.ai/build/cli", login: ["grok", "login"], homeVariable: "GROK_HOME", defaultHome: () => join(homedir(), ".grok") },
  opencode: { title: "OpenCode", command: "opencode", args: ["acp"], installUrl: "https://opencode.ai/docs", login: ["opencode", "auth", "login"], homeVariable: "XDG_DATA_HOME", defaultHome: () => process.env.XDG_DATA_HOME || join(homedir(), ".local", "share") },
} satisfies Record<NativeAgentId, { title: string; command: string; args: string[]; installUrl: string; login: string[]; homeVariable: string; defaultHome(): string }>;

export function nativeAgentLaunch(provider: NativeAgentId, config?: Partial<ProviderConfig>) {
  const definition = NATIVE_AGENTS[provider];
  const command = config?.binaryPath || definition.command;
  if (config?.binaryPath && !isAbsolute(config.binaryPath)) throw new Error("A configured agent executable must be an absolute path.");
  if (config?.sourceHome && !isAbsolute(config.sourceHome)) throw new Error("A configured agent home must be an absolute path.");
  const sourceHome = resolve(config?.sourceHome || process.env[definition.homeVariable] || definition.defaultHome());
  const env = { ...process.env, [definition.homeVariable]: sourceHome };
  const instanceId = createHash("sha256").update(JSON.stringify({ provider, command, sourceHome, uid: process.getuid?.() ?? homedir() })).digest("hex");
  return { command, args: definition.args, env, instanceId, sourceHome };
}
