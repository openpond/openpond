import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AcpClient } from "@openpond/agent-runtime/acp/client";
import { ClaudeCliClient } from "@openpond/agent-runtime/acp/claude-cli-client";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { nativeAgentLaunch, type NativeAgentId } from "./config.js";
import { probeNativeAgent } from "./setup.js";

export async function nativeHistoryWorkspaceAvailable(cwd: string): Promise<boolean> {
  if (!isAbsolute(cwd)) return false;
  try {
    if (!(await stat(cwd)).isDirectory()) return false;
    await access(cwd, constants.R_OK | constants.X_OK);
    return true;
  } catch { return false; }
}

export function createNativeHistoryWorkspace(providersFilePath: string) {
  return {
    workspaceAvailable: nativeHistoryWorkspaceAvailable,
    async canResume(provider: NativeAgentId) {
      const file = await readProvidersFile(providersFilePath);
      if (!file.providers[provider]?.enabled) return { available: false, reason: "Enable the original agent in Connections before continuing this conversation." };
      const status = await probeNativeAgent(provider, file.providers[provider]);
      const qualified = status.status === "ready" && status.capabilities?.loadSession === true;
      return { available: qualified, reason: qualified ? null : status.error ?? "This agent does not advertise saved-session continuation. Check its installation and login in Connections, then check again." };
    },
    async qualifyWorkspace(input: { provider: NativeAgentId; sessionId: string; instanceId: string; cwd: string }) {
      if (!await nativeHistoryWorkspaceAvailable(input.cwd)) throw new Error("The app workspace is inaccessible. Check local folder permissions and try again.");
      const file = await readProvidersFile(providersFilePath);
      const config = file.providers[input.provider];
      if (!config?.enabled) throw new Error("Enable the original agent in Connections before continuing this conversation.");
      const launch = nativeAgentLaunch(input.provider, config);
      if (launch.instanceId !== input.instanceId) throw new Error("The agent configuration changed. Check the connection and try again.");
      const Client = input.provider === "claude-code" ? ClaudeCliClient : AcpClient;
      const client = new Client({ ...launch, cwd: input.cwd, requestTimeoutMs: 15_000,
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      });
      try {
        const info = await client.initialize();
        if (!info.agentCapabilities?.loadSession) throw new Error("This agent cannot resume saved conversations.");
        if (config.acp?.authMethodId) await client.authenticate(config.acp.authMethodId);
        else if (input.provider === "grok-build" && info.authMethods?.some(method => method.id === "cached_token")) await client.authenticate("cached_token");
        const native = await client.loadSession(input.sessionId, input.cwd);
        if (native.sessionId !== input.sessionId) throw new Error("The agent returned a different conversation; the saved conversation was not changed.");
        const latest = await readProvidersFile(providersFilePath);
        if (!latest.providers[input.provider]?.enabled || nativeAgentLaunch(input.provider, latest.providers[input.provider]).instanceId !== input.instanceId)
          throw new Error("The agent configuration changed during recovery. Check the connection and try again.");
      } finally { await client.stop(); }
    },
  };
}
