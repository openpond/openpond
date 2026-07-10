import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DevRunnerMode = "desktop" | "web" | "server" | "renderer";

export type DevRunnerOptions = {
  mode: DevRunnerMode;
  printPlan: boolean;
  host: string;
  serverPort?: number;
  webPort?: number;
};

export type DevRunnerCommand = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type DevRunnerPlan = {
  mode: DevRunnerMode;
  root: string;
  host: string;
  ports: {
    server: number;
    web: number;
  };
  urls: {
    server: string;
    web: string;
  };
  setupCommands: DevRunnerCommand[];
  processes: DevRunnerCommand[];
};

type ReadyPayload = {
  url?: string;
  tokenFile?: string;
};

type RunningProcess = {
  id: string;
  child: ChildProcessWithoutNullStreams;
};

type ProcessExit = {
  id: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

const READY_PREFIX = "OPENPOND_APP_SERVER_READY ";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseDevRunnerArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DevRunnerOptions {
  let mode: DevRunnerMode | null = null;
  let printPlan = false;
  let host = env.OPENPOND_DEV_HOST || "127.0.0.1";
  let serverPort = numberFromEnv(env.OPENPOND_SERVER_PORT);
  let webPort = numberFromEnv(env.OPENPOND_WEB_PORT);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--print-plan" || arg === "--dry-run") {
      printPlan = true;
      continue;
    }
    if (arg === "--host") {
      host = valueAfterFlag(argv, (index += 1), arg);
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--server-port") {
      serverPort = parsePort(valueAfterFlag(argv, (index += 1), arg), arg);
      continue;
    }
    if (arg.startsWith("--server-port=")) {
      serverPort = parsePort(arg.slice("--server-port=".length), "--server-port");
      continue;
    }
    if (arg === "--web-port") {
      webPort = parsePort(valueAfterFlag(argv, (index += 1), arg), arg);
      continue;
    }
    if (arg.startsWith("--web-port=")) {
      webPort = parsePort(arg.slice("--web-port=".length), "--web-port");
      continue;
    }
    if (arg === "--mode") {
      mode = parseMode(valueAfterFlag(argv, (index += 1), arg));
      continue;
    }
    if (arg.startsWith("--mode=")) {
      mode = parseMode(arg.slice("--mode=".length));
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown dev runner option: ${arg}`);
    if (mode) throw new Error(`Unexpected extra dev runner argument: ${arg}`);
    mode = parseMode(arg);
  }

  return {
    mode: mode ?? "desktop",
    printPlan,
    host,
    serverPort,
    webPort,
  };
}

export function buildDevRunnerPlan(
  options: DevRunnerOptions,
  env: NodeJS.ProcessEnv = process.env,
  root = ROOT,
): DevRunnerPlan {
  const host = options.host;
  const serverPort =
    options.serverPort ?? numberFromEnv(env.OPENPOND_SERVER_PORT) ?? defaultServerPort(env);
  const webPort = options.webPort ?? numberFromEnv(env.OPENPOND_WEB_PORT) ?? 17876;
  const serverUrl = `http://${host}:${serverPort}`;
  const webUrl = `http://${host}:${webPort}`;
  const baseEnv = {
    OPENPOND_SERVER_PORT: String(serverPort),
    OPENPOND_WEB_PORT: String(webPort),
    OPENPOND_WEB_URL: webUrl,
    OPENPOND_REMOTE_ACCESS_TARGET: webUrl,
  };
  const serverEnv = {
    ...baseEnv,
    OPENPOND_REMOTE_ACCESS_TARGET: webUrl,
  };
  const rendererEnv = {
    ...baseEnv,
    VITE_OPENPOND_SERVER_URL: serverUrl,
  };
  const desktopEnv = {
    ...baseEnv,
    OPENPOND_WEB_URL: webUrl,
  };
  const setupCommands: DevRunnerCommand[] = [];
  const processes: DevRunnerCommand[] = [];

  if (options.mode === "desktop") {
    setupCommands.push(command("build-desktop", bunBinary(env), ["run", "build:desktop"], root));
    processes.push(watchedServerCommand(root, env, serverPort, serverEnv));
    processes.push(command("renderer", bunBinary(env), ["run", "--cwd", "apps/web", "dev"], root, rendererEnv));
    processes.push(command("desktop", electronBinary(root), ["."], path.join(root, "apps", "desktop"), desktopEnv));
  }

  if (options.mode === "web") {
    processes.push(watchedServerCommand(root, env, serverPort, serverEnv));
    processes.push(command("renderer", bunBinary(env), ["run", "--cwd", "apps/web", "dev"], root, rendererEnv));
  }

  if (options.mode === "server") {
    processes.push(watchedServerCommand(root, env, serverPort, serverEnv));
  }

  if (options.mode === "renderer") {
    processes.push(command("renderer", bunBinary(env), ["run", "--cwd", "apps/web", "dev"], root, rendererEnv));
  }

  return {
    mode: options.mode,
    root,
    host,
    ports: {
      server: serverPort,
      web: webPort,
    },
    urls: {
      server: serverUrl,
      web: webUrl,
    },
    setupCommands,
    processes,
  };
}

async function runDevPlan(plan: DevRunnerPlan): Promise<void> {
  for (const setup of plan.setupCommands) runSetupCommand(setup);

  const running: RunningProcess[] = [];
  const serverProcess = plan.processes.find((processPlan) => processPlan.id === "server");
  const rendererProcess = plan.processes.find((processPlan) => processPlan.id === "renderer");
  const desktopProcess = plan.processes.find((processPlan) => processPlan.id === "desktop");

  try {
    if (serverProcess) {
      const server = startProcess(serverProcess, { captureReady: true });
      running.push({ id: serverProcess.id, child: server.child });
      const serverReady = await server.ready;
      const token = await readToken(serverReady.tokenFile);
      if (!token) throw new Error(`OpenPond App server did not write a capability token at ${serverReady.tokenFile ?? tokenFilePath()}`);
      const serverUrl = serverReady.url ?? plan.urls.server;
      if (rendererProcess) {
        rendererProcess.env.VITE_OPENPOND_SERVER_URL = serverUrl;
        rendererProcess.env.VITE_OPENPOND_TOKEN = token;
      }
      if (desktopProcess) {
        desktopProcess.env.OPENPOND_SERVER_URL = serverUrl;
        desktopProcess.env.OPENPOND_APP_TOKEN = token;
        desktopProcess.env.OPENPOND_REUSE_SERVER = "1";
      }
      console.log(`OpenPond server ready at ${serverUrl}`);
    }

    if (rendererProcess) {
      const renderer = startProcess(rendererProcess);
      running.push({ id: rendererProcess.id, child: renderer.child });
      await waitForUrl(plan.urls.web);
      console.log(`OpenPond renderer ready at ${plan.urls.web}`);
    }

    if (desktopProcess) {
      const desktop = startProcess(desktopProcess);
      running.push({ id: desktopProcess.id, child: desktop.child });
    }

    if (running.length === 0) throw new Error(`No dev processes were configured for mode ${plan.mode}`);
    const exit = await waitForExitOrSignal(running);
    if (exit.id === "supervisor") {
      process.exitCode = exit.code ?? 0;
      return;
    }
    if (exit.code && exit.code !== 0) throw new Error(`${exit.id} exited with code ${exit.code}`);
    if (exit.signal) throw new Error(`${exit.id} exited with signal ${exit.signal}`);
  } finally {
    await stopRunningProcesses(running);
  }
}

function runSetupCommand(setup: DevRunnerCommand): void {
  console.log(`Running ${setup.id}: ${formatCommand(setup)}`);
  const result = spawnSync(setup.command, setup.args, {
    cwd: setup.cwd,
    env: childEnv(setup.env),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${setup.id} failed with code ${result.status ?? "unknown"}`);
  }
}

function startProcess(
  processPlan: DevRunnerCommand,
  options: { captureReady?: boolean } = {},
): { child: ChildProcessWithoutNullStreams; ready: Promise<ReadyPayload> } {
  console.log(`Starting ${processPlan.id}: ${formatCommand(processPlan)}`);
  const child = spawn(processPlan.command, processPlan.args, {
    cwd: processPlan.cwd,
    env: childEnv(processPlan.env),
    detached: process.platform !== "win32",
  });
  const ready = options.captureReady ? waitForReady(child, processPlan.id) : Promise.resolve({});

  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(prefixLines(processPlan.id, chunk.toString("utf8")));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(prefixLines(processPlan.id, chunk.toString("utf8")));
  });
  child.on("error", (error) => {
    console.error(`${processPlan.id} failed to start: ${error.message}`);
  });

  return { child, ready };
}

function waitForReady(child: ChildProcessWithoutNullStreams, processId: string): Promise<ReadyPayload> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (payload: ReadyPayload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
    };
    const timer = setTimeout(
      () => fail(new Error(`${processId} did not print ${READY_PREFIX.trim()} in time`)),
      15000,
    );
    const onStdout = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith(READY_PREFIX)) {
          finish(JSON.parse(line.slice(READY_PREFIX.length)) as ReadyPayload);
          return;
        }
        newline = buffer.indexOf("\n");
      }
    };
    const onExit = (code: number | null) => {
      fail(new Error(`${processId} exited before ready with code ${code ?? "unknown"}`));
    };
    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
  });
}

async function waitForUrl(url: string, timeoutMs = 20000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the renderer is ready or the timeout expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function waitForExitOrSignal(processes: RunningProcess[]): Promise<ProcessExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exit: ProcessExit) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(exit);
    };
    const onInterrupt = () => finish({ id: "supervisor", code: 130, signal: "SIGINT" });
    const onTerminate = () => finish({ id: "supervisor", code: 143, signal: "SIGTERM" });
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    for (const item of processes) {
      item.child.once("exit", (code, signal) => {
        finish({ id: item.id, code, signal });
      });
    }
  });
}

async function stopRunningProcesses(processes: RunningProcess[]): Promise<void> {
  await Promise.all([...processes].reverse().map(({ child }) => stopProcessTree(child)));
}

async function stopProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForChildExit(child, 5_000)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForChildExit(child, 2_000))) {
    throw new Error(`Dev child process tree ${child.pid ?? "unknown"} did not exit`);
  }
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
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

async function readToken(file = tokenFilePath()): Promise<string | null> {
  if (process.env.OPENPOND_APP_TOKEN?.trim()) return process.env.OPENPOND_APP_TOKEN.trim();
  try {
    const token = (await fs.readFile(file, "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

function tokenFilePath(): string {
  return path.join(process.env.OPENPOND_APP_HOME || path.join(os.homedir(), ".openpond", "openpond-app"), "token");
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
  };
}

function command(
  id: string,
  commandValue: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): DevRunnerCommand {
  return {
    id,
    command: commandValue,
    args,
    cwd,
    env,
  };
}

function formatCommand(commandValue: DevRunnerCommand): string {
  return [commandValue.command, ...commandValue.args].join(" ");
}

function prefixLines(prefix: string, value: string): string {
  return value
    .split(/(?<=\n)/)
    .map((line) => (line ? `[${prefix}] ${line}` : line))
    .join("");
}

function defaultServerPort(env: NodeJS.ProcessEnv): number {
  return env.OPENPOND_APP_CHANNEL === "nightly" ? 17875 : 17874;
}

function bunBinary(env: NodeJS.ProcessEnv): string {
  if (env.BUN_BINARY) return env.BUN_BINARY;
  return process.versions.bun ? process.execPath : "bun";
}

function watchedServerCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  serverPort: number,
  serverEnv: Record<string, string>,
): DevRunnerCommand {
  return command(
    "server",
    bunBinary(env),
    ["--watch", "apps/server/src/index.ts", "--port", String(serverPort)],
    root,
    serverEnv,
  );
}

function electronBinary(root: string): string {
  return path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePort(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${flag} must be a TCP port between 0 and 65535`);
  }
  return parsed;
}

function parseMode(value: string): DevRunnerMode {
  if (value === "desktop" || value === "web" || value === "server" || value === "renderer") {
    return value;
  }
  throw new Error(`Unknown dev mode: ${value}`);
}

function valueAfterFlag(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseDevRunnerArgs(process.argv.slice(2));
  const plan = buildDevRunnerPlan(options);
  if (options.printPlan) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    void runDevPlan(plan).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}
