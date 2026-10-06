import type { ProviderConfig, Session } from "@openpond/contracts";
import { access, constants } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { isNativeAgentId, nativeAgentLaunch } from "../native-agents/config.js";

async function executableAvailable(command: string): Promise<boolean> {
  const names = process.platform === "win32" && !extname(command)
    ? [command, ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => command + extension)]
    : [command];
  const candidates = isAbsolute(command) ? names : (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((directory) => names.map((name) => join(directory, name)));
  for (const candidate of candidates) {
    try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
    catch { /* Continue through PATH without launching an agent. */ }
  }
  return false;
}

/** Rechecks the original local installation; never starts or attaches a session. */
export function createLocalManagedReadiness(deps: {
  configProvider(provider: string): Promise<ProviderConfig | null>;
  codexStatus(): Promise<{ available: boolean; enabled: boolean; reason: string | null }>;
  nativeStatus?(session: Session): Promise<{ available: boolean; reason: string | null }>;
}) {
  return async (session: Session): Promise<{ available: boolean; canSteer: boolean; reason: string | null }> => {
    const unavailable = (reason: string) => ({ available: false, canSteer: false, reason });
    if (session.provider === "codex") {
      if (!session.codexThreadId || !session.cwd) return unavailable("This conversation has no original managed Codex thread and working directory.");
      const status = await deps.codexStatus();
      if (!status.enabled || !status.available) return unavailable(status.reason ?? "The local Codex installation is unavailable or disabled.");
      return { available: true, canSteer: true, reason: null };
    }
    if (!isNativeAgentId(session.provider) || !session.nativeAgent) return unavailable("Imported history has no qualified managed session.");
    const config = await deps.configProvider(session.provider);
    if (!config?.enabled) return unavailable("Enable the original local agent in Providers before sending.");
    let launch: ReturnType<typeof nativeAgentLaunch>;
    try { launch = nativeAgentLaunch(session.provider, config); }
    catch (error) { return unavailable(error instanceof Error ? error.message : "The local agent configuration is invalid."); }
    if (session.nativeAgent.provider !== session.provider || session.nativeAgent.instanceId !== launch.instanceId
      || !session.cwd || session.nativeAgent.cwd !== session.cwd) {
      return unavailable("The original agent installation, account configuration or working directory changed. Restore it before sending.");
    }
    if (!await executableAvailable(launch.command)) return unavailable("The original local agent executable is unavailable. Restore it before sending.");
    if (deps.nativeStatus) {
      const status = await deps.nativeStatus(session);
      if (!status.available) return unavailable(status.reason ?? "The original local agent is unavailable.");
    }
    return { available: true, canSteer: false, reason: null };
  };
}
