import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DesktopServerHealth = {
  ok: boolean;
  server?: string;
  version?: string;
  runtimeVersion?: string;
};

export function isCompatibleDesktopServer(
  health: DesktopServerHealth | null,
  desktopVersion: string,
): boolean {
  return (
    health?.ok === true &&
    health.server === "openpond-app-server" &&
    health.version === desktopVersion
  );
}

export function canReuseDesktopServer(input: {
  health: DesktopServerHealth | null;
  desktopVersion: string;
  token: string | null;
  packaged: boolean;
  explicitServerUrl: boolean;
  reuseRequested: boolean;
  rendererAvailable: boolean;
}): boolean {
  return (
    Boolean(input.token) &&
    isCompatibleDesktopServer(input.health, input.desktopVersion) &&
    input.rendererAvailable &&
    (input.explicitServerUrl || (!input.packaged && input.reuseRequested))
  );
}

export function canLaunchBundledDesktopServer(explicitServerUrl: boolean): boolean {
  return !explicitServerUrl;
}

export function localServerPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1") {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

export function parseListeningProcessIds(output: string): number[] {
  return Array.from(
    new Set(
      output
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
}

export function bundledServerLaunchPort(
  defaultPort: number,
  existingHealth: DesktopServerHealth | null,
  staleServerStopped: boolean,
): number {
  return !staleServerStopped || existingHealth?.ok ? 0 : defaultPort;
}

export async function stopStaleLocalDesktopServer(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    currentPid?: number;
    timeoutMs?: number;
    findProcessIds?: (port: number, platform: NodeJS.Platform) => Promise<number[]>;
    terminateProcess?: (pid: number, platform: NodeJS.Platform, timeoutMs?: number) => Promise<void>;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): Promise<{ stopped: boolean; processIds: number[] }> {
  const port = localServerPort(url);
  if (!port) return { stopped: false, processIds: [] };

  const platform = options.platform ?? process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const findProcessIds = options.findProcessIds ?? listeningProcessIds;
  const terminateProcess = options.terminateProcess ?? terminateProcessTree;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const processIds = (await findProcessIds(port, platform)).filter((pid) => pid !== currentPid);
  if (processIds.length === 0) return { stopped: false, processIds: [] };

  await Promise.all(processIds.map((pid) => terminateProcess(pid, platform, options.timeoutMs)));
  return {
    stopped: processIds.every((pid) => !isProcessAlive(pid)),
    processIds,
  };
}

async function listeningProcessIds(port: number, platform: NodeJS.Platform): Promise<number[]> {
  try {
    if (platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`,
        ],
        { encoding: "utf8", timeout: 3_000, windowsHide: true },
      );
      return parseListeningProcessIds(stdout);
    }
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8", timeout: 3_000, windowsHide: true },
    );
    return parseListeningProcessIds(stdout);
  } catch {
    return [];
  }
}

async function terminateProcessTree(
  pid: number,
  platform: NodeJS.Platform,
  timeoutMs = 5_000,
): Promise<void> {
  if (platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      timeout: timeoutMs,
      windowsHide: true,
    }).catch(() => undefined);
    return;
  }

  signalProcess(pid, "SIGTERM");
  if (await waitForProcessExit(pid, timeoutMs)) return;
  signalProcess(pid, "SIGKILL");
  await waitForProcessExit(pid, 2_000);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process already exited.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIsAlive(pid);
}
