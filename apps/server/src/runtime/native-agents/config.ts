import { existsSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isRegisteredAcpProvider, type ProviderConfig } from "@openpond/contracts";

export const NATIVE_AGENT_IDS = ["claude-code", "grok-build", "opencode"] as const;
export type BuiltinNativeAgentId = typeof NATIVE_AGENT_IDS[number];
export type NativeAgentId = BuiltinNativeAgentId | `acp:${string}`;
export function isNativeAgentId(value: string): value is NativeAgentId { return isRegisteredAcpProvider(value) || (NATIVE_AGENT_IDS as readonly string[]).includes(value); }
export const NATIVE_AGENTS = {
  "claude-code": { title: "Claude Code", command: "claude", args: [] as string[], installUrl: "https://code.claude.com/docs/en/setup", login: ["claude", "auth", "login"], homeVariable: "CLAUDE_CONFIG_DIR", defaultHome: () => join(homedir(), ".claude") },
  "grok-build": { title: "Grok Build", command: "grok", args: ["--no-auto-update", "agent", "stdio"], installUrl: "https://docs.x.ai/build/cli", login: ["grok", "login"], homeVariable: "GROK_HOME", defaultHome: () => join(homedir(), ".grok") },
  opencode: { title: "OpenCode", command: "opencode", args: ["acp"], installUrl: "https://opencode.ai/docs", login: ["opencode", "auth", "login"], homeVariable: "XDG_DATA_HOME", defaultHome: () => process.env.XDG_DATA_HOME || join(homedir(), ".local", "share") },
} satisfies Record<BuiltinNativeAgentId, { title: string; command: string; args: string[]; installUrl: string; login: string[]; homeVariable: string; defaultHome(): string }>;

export function nativeAgentLaunch(provider: NativeAgentId, config?: Partial<ProviderConfig>) {
  if (isRegisteredAcpProvider(provider)) {
    if (!config?.acp) throw new Error("ACP agent registration is missing. Configure it in Providers.");
    if (config.sourceHome && !isAbsolute(config.sourceHome)) throw new Error("A configured agent home must be an absolute path.");
    let command = config.binaryPath || config.acp.command;
    if (config.binaryPath && !isAbsolute(config.binaryPath)) throw new Error("A configured agent executable must be an absolute path.");
    let args = config.acp.args;
    const configuredHome = config.sourceHome || config.acp.env.HOME;
    if (configuredHome && !isAbsolute(configuredHome)) throw new Error("A configured agent home must be an absolute path.");
    const sourceHome = resolve(configuredHome || homedir());
    const env: NodeJS.ProcessEnv = { ...process.env, ...(config.sourceHome ? { HOME: sourceHome, ...(process.platform === "win32" ? { USERPROFILE: sourceHome } : {}) } : {}), ...config.acp.env };
    // npx is a .cmd shim on Windows. Run npm's JS entry with the server's
    // Node runtime instead of introducing a shell or interpolating arguments.
    if (process.platform === "win32" && command === "npx" && !config.binaryPath) {
      const npmScript = (env.PATH ?? process.env.Path ?? "").split(delimiter)
        .map(directory => join(directory, "node_modules", "npm", "bin", "npx-cli.js")).find(existsSync)
        ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
      if (!existsSync(npmScript)) throw new Error("Install Node.js with npm to run this ACP package, or configure a custom executable.");
      command = process.execPath; args = [npmScript, ...args];
    }
    const instanceId = createHash("sha256").update(JSON.stringify({ provider, command, args, env: config.acp.env, sourceHome, authMethodId: config.acp.authMethodId, uid: process.getuid?.() ?? homedir() })).digest("hex");
    return { command, args, env, instanceId, sourceHome };
  }
  const definition = NATIVE_AGENTS[provider];
  const command = config?.binaryPath || definition.command;
  if (config?.binaryPath && !isAbsolute(config.binaryPath)) throw new Error("A configured agent executable must be an absolute path.");
  if (config?.sourceHome && !isAbsolute(config.sourceHome)) throw new Error("A configured agent home must be an absolute path.");
  const sourceHome = resolve(config?.sourceHome || process.env[definition.homeVariable] || definition.defaultHome());
  const env = { ...process.env, [definition.homeVariable]: sourceHome };
  const instanceId = createHash("sha256").update(JSON.stringify({ provider, command, sourceHome, uid: process.getuid?.() ?? homedir() })).digest("hex");
  return { command, args: definition.args, env, instanceId, sourceHome };
}
