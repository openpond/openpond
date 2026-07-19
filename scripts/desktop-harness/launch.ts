import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedOpenPondEnvironment } from "../isolated-openpond-environment.js";
import type { DesktopHarnessConnection } from "./types.js";
import {
  CdpClient,
  rendererConnection,
  waitFor,
  waitForDevtoolsTarget,
  waitForRendererBridge,
} from "./cdp.js";

export type ProcessHandle = {
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
  processGroup: boolean;
};

export type IsolatedDesktopHarness = {
  appHome: string;
  userData: string;
  webPort: number;
  devtoolsPort: number;
  webUrl: string;
  connection: DesktopHarnessConnection;
  cdp: CdpClient;
  restart(): Promise<{ connection: DesktopHarnessConnection; cdp: CdpClient }>;
  close(): Promise<void>;
};

export type PackagedDesktopHarness = {
  appHome: string;
  userData: string;
  devtoolsPort: number;
  appPath: string;
  connection: DesktopHarnessConnection;
  cdp: CdpClient;
  close(): Promise<void>;
};

type PackagedLaunchTarget = {
  command: string;
  args: string[];
  appPath: string;
};

const expectedStops = new WeakSet<ChildProcessWithoutNullStreams>();

export async function launchIsolatedDesktopHarness(input: {
  repoRoot: string;
  timeoutMs: number;
  keepHome?: boolean;
}): Promise<IsolatedDesktopHarness> {
  const appHome = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-harness-home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-harness-user-data-"));
  const webPort = await freePort();
  const devtoolsPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  let renderer: ProcessHandle | null = null;
  let desktop: ProcessHandle | null = null;
  let cdp: CdpClient | null = null;

  try {
    runSetup(input.repoRoot, "bundle-server", [pnpmBinary(), "run", "bundle:server"]);
    runSetup(input.repoRoot, "build-desktop", [pnpmBinary(), "run", "build:desktop"]);
    renderer = startRenderer(input.repoRoot, webPort);
    await waitForUrl(webUrl, input.timeoutMs);
    const startDesktop = async () => {
      desktop = launchDevElectron({
        repoRoot: input.repoRoot,
        appHome,
        devtoolsPort,
        userData,
        webUrl,
        webPort,
      });
      const target = await waitForDevtoolsTarget(devtoolsPort, input.timeoutMs, (candidate) =>
        candidate.url === webUrl || candidate.url.startsWith(`${webUrl}/`) || candidate.url.startsWith(`${webUrl}?`),
      );
      cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
      await waitForRendererBridge(cdp, input.timeoutMs);
      const connection = await rendererConnection(cdp);
      if (!connection.token) throw new Error("Desktop renderer connection did not expose a capability token.");
      return { connection, cdp };
    };
    const started = await startDesktop();
    const connection = started.connection;
    return {
      appHome,
      userData,
      webPort,
      devtoolsPort,
      webUrl,
      connection,
      cdp: started.cdp,
      restart: async () => {
        cdp?.close();
        await stopDesktopHarnessProcess(desktop);
        desktop = null;
        cdp = null;
        return startDesktop();
      },
      close: async () => {
        cdp?.close();
        await stopDesktopHarnessProcess(desktop);
        await stopDesktopHarnessProcess(renderer);
        await rm(userData, { recursive: true, force: true });
        if (!input.keepHome) await rm(appHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    cdp?.close();
    await stopDesktopHarnessProcess(desktop);
    await stopDesktopHarnessProcess(renderer);
    await rm(userData, { recursive: true, force: true });
    if (!input.keepHome) await rm(appHome, { recursive: true, force: true });
    throw error;
  }
}

export async function launchPackagedDesktopHarness(input: {
  repoRoot: string;
  timeoutMs: number;
  keepHome?: boolean;
  appPath?: string | null;
}): Promise<PackagedDesktopHarness> {
  const appHome = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-harness-packaged-home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-harness-packaged-user-data-"));
  const devtoolsPort = await freePort();
  let desktop: ProcessHandle | null = null;
  let cdp: CdpClient | null = null;

  try {
    const target = resolvePackagedLaunchTarget(input.repoRoot, input.appPath);
    desktop = launchPackagedElectron({
      target,
      appHome,
      userData,
      devtoolsPort,
      repoRoot: input.repoRoot,
    });
    const devtoolsTarget = await waitForDevtoolsTarget(devtoolsPort, input.timeoutMs, () => true);
    cdp = await CdpClient.connect(devtoolsTarget.webSocketDebuggerUrl);
    await waitForRendererBridge(cdp, input.timeoutMs);
    const connection = await rendererConnection(cdp);
    if (!connection.token) throw new Error("Packaged renderer connection did not expose a capability token.");
    return {
      appHome,
      userData,
      devtoolsPort,
      appPath: target.appPath,
      connection,
      cdp,
      close: async () => {
        cdp?.close();
        await stopDesktopHarnessProcess(desktop);
        await rm(userData, { recursive: true, force: true });
        if (!input.keepHome) await rm(appHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    cdp?.close();
    await stopDesktopHarnessProcess(desktop);
    await rm(userData, { recursive: true, force: true });
    if (!input.keepHome) await rm(appHome, { recursive: true, force: true });
    throw error;
  }
}

function runSetup(repoRoot: string, label: string, command: [string, ...string[]]): void {
  console.log(`Running ${label}: ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${label} failed with code ${result.status ?? "unknown"}`);
}

function startRenderer(repoRoot: string, webPort: number): ProcessHandle {
  const child = spawn(pnpmBinary(), ["--dir", "apps/web", "run", "dev"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENPOND_WEB_PORT: String(webPort),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trackDesktopHarnessProcess("renderer", child);
}

function launchDevElectron(input: {
  repoRoot: string;
  appHome: string;
  devtoolsPort: number;
  userData: string;
  webUrl: string;
  webPort: number;
}): ProcessHandle {
  const appArgs = [
    ".",
    `--remote-debugging-port=${input.devtoolsPort}`,
    `--user-data-dir=${input.userData}`,
    "--disable-gpu",
    "--no-sandbox",
  ];
  const electron = path.join(input.repoRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const wrapped = wrapForDisplay(electron, appArgs);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: path.join(input.repoRoot, "apps", "desktop"),
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      OPENPOND_HARNESS_SCRIPTED_MODELS: "1",
      ...isolatedOpenPondEnvironment(input.appHome),
      OPENPOND_SERVER_PORT: "0",
      OPENPOND_WEB_PORT: String(input.webPort),
      OPENPOND_WEB_URL: input.webUrl,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trackDesktopHarnessProcess("desktop", child);
}

function resolvePackagedLaunchTarget(repoRoot: string, appPath?: string | null): PackagedLaunchTarget {
  const explicit = appPath?.trim() || process.env.OPENPOND_DESKTOP_APP_PATH?.trim();
  if (explicit) return packagedLaunchTargetForPath(path.resolve(repoRoot, explicit));
  const candidates = packagedAppCandidates(repoRoot);
  const candidate = candidates.find((item) => existsSync(item));
  if (candidate) return packagedLaunchTargetForPath(candidate);
  throw new Error(
    `No packaged desktop app was found. Run the platform package script first, or pass --app. Checked: ${candidates.join(", ")}`,
  );
}

function packagedAppCandidates(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") {
    return [
      path.join(repoRoot, "release", "mac", "openpond.app"),
      path.join(repoRoot, "release", "mac", "openpond nightly.app"),
      path.join(repoRoot, "release", "mac-arm64", "openpond.app"),
      path.join(repoRoot, "release", "mac-arm64", "openpond nightly.app"),
      path.join(repoRoot, "release", "mac-universal", "openpond.app"),
      path.join(repoRoot, "release", "mac-universal", "openpond nightly.app"),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(repoRoot, "release", "win-unpacked", "openpond.exe"),
      path.join(repoRoot, "release", "win-unpacked", "openpond nightly.exe"),
      path.join(repoRoot, "release", "win-ia32-unpacked", "openpond.exe"),
      path.join(repoRoot, "release", "win-ia32-unpacked", "openpond nightly.exe"),
      path.join(repoRoot, "release", "win-arm64-unpacked", "openpond.exe"),
      path.join(repoRoot, "release", "win-arm64-unpacked", "openpond nightly.exe"),
    ];
  }
  const linuxAppImages = existingReleaseFiles(repoRoot)
    .filter((file) => file.endsWith(".AppImage"))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => path.join(repoRoot, "release", file));
  return [
    path.join(repoRoot, "release", "linux-unpacked", "openpond"),
    path.join(repoRoot, "release", "linux-unpacked", "openpond nightly"),
    ...linuxAppImages,
    path.join(repoRoot, "release", "openpond-0.0.1.AppImage"),
  ];
}

function existingReleaseFiles(repoRoot: string): string[] {
  try {
    return readdirSync(path.join(repoRoot, "release"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function packagedLaunchTargetForPath(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): PackagedLaunchTarget {
  if (platform === "darwin" && appPath.endsWith(".app")) {
    const executableName = path.basename(appPath, ".app");
    return {
      command: path.join(appPath, "Contents", "MacOS", executableName),
      args: [],
      appPath,
    };
  }
  return { command: appPath, args: [], appPath };
}

function launchPackagedElectron(input: {
  target: PackagedLaunchTarget;
  appHome: string;
  userData: string;
  devtoolsPort: number;
  repoRoot: string;
}): ProcessHandle {
  const appArgs = [
    ...input.target.args,
    `--remote-debugging-port=${input.devtoolsPort}`,
    `--user-data-dir=${input.userData}`,
    "--disable-gpu",
    "--no-sandbox",
  ];
  const wrapped = wrapForDisplay(input.target.command, appArgs);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: input.repoRoot,
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      OPENPOND_HARNESS_SCRIPTED_MODELS: "1",
      ...isolatedOpenPondEnvironment(input.appHome),
      OPENPOND_SERVER_PORT: "0",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trackDesktopHarnessProcess("packaged-desktop", child);
}

export function trackDesktopHarnessProcess(
  label: string,
  child: ChildProcessWithoutNullStreams,
): ProcessHandle {
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => {
    if (expectedStops.has(child)) return;
    process.stdout.write(prefixLines(label, chunk.toString("utf8")));
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr.push(text);
    if (stderr.join("").length > 32_000) stderr.splice(0, stderr.length - 20);
    if (expectedStops.has(child)) return;
    process.stderr.write(prefixLines(label, text));
  });
  child.on("exit", (code, signal) => {
    if (code === 0 || signal || expectedStops.has(child)) return;
    console.error(`${label} exited early with code ${code}. stderr:\n${stderr.join("")}`);
  });
  return { child, stderr, processGroup: process.platform !== "win32" };
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, timeoutMs, `Timed out waiting for ${url}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port.");
  return address.port;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function stopDesktopHarnessProcess(handle: ProcessHandle | null): Promise<void> {
  if (!handle) return;
  expectedStops.add(handle.child);
  const childWasRunning = handle.child.exitCode === null && handle.child.signalCode === null;
  const descendants = childWasRunning && handle.child.pid ? descendantPids(handle.child.pid) : [];
  signalProcess(handle, "SIGTERM");
  signalPids(descendants, "SIGTERM");
  const stopped = await waitForTrackedProcessExit(handle, childWasRunning, 3_000);
  if (!stopped) {
    signalProcess(handle, "SIGKILL");
  }
  signalPids(descendants, "SIGKILL");
  if (!stopped && !(await waitForTrackedProcessExit(handle, childWasRunning, 1_000))) {
    throw new Error(`Desktop harness process tree ${handle.child.pid ?? "unknown"} did not exit.`);
  }
}

async function waitForTrackedProcessExit(
  handle: ProcessHandle,
  childWasRunning: boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (handle.processGroup && handle.child.pid) {
    const deadline = Date.now() + timeoutMs;
    while (processGroupIsAlive(handle.child.pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  }
  return !childWasRunning || await waitForExit(handle.child, timeoutMs);
}

function processGroupIsAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcess(handle: ProcessHandle, signal: NodeJS.Signals): void {
  if (handle.processGroup && handle.child.pid) {
    try {
      process.kill(-handle.child.pid, signal);
      return;
    } catch {
      // Fall through when the process group already exited between the liveness check and signal.
    }
  }
  handle.child.kill(signal);
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    const current = children.get(parent) ?? [];
    current.push(pid);
    children.set(parent, current);
  }
  const ordered: number[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      visit(child);
      ordered.push(child);
    }
  };
  visit(rootPid);
  return ordered;
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // The descendant may already have exited through its parent's graceful shutdown.
    }
  }
}

function wrapForDisplay(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "linux" || process.env.DISPLAY) return { command, args };
  if (commandExists("xvfb-run")) return { command: "xvfb-run", args: ["-a", command, ...args] };
  throw new Error("No DISPLAY is available. Install xvfb and rerun through xvfb-run for Linux desktop harness.");
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return pathValue.split(path.delimiter).some((dir) =>
    extensions.some((extension) => existsSync(path.join(dir, `${command}${extension}`))),
  );
}

function prefixLines(prefix: string, value: string): string {
  return value
    .split(/(?<=\n)/)
    .map((line) => (line ? `[${prefix}] ${line}` : line))
    .join("");
}

function pnpmBinary(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
