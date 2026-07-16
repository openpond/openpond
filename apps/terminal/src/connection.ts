import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createReadyLineParser } from "@openpond/runtime";

export type TerminalConnectionOptions = {
  server: string;
  noServerStart: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverProcess: ChildProcessWithoutNullStreams | null = null;
let stopServerPromise: Promise<void> | null = null;

function tokenFilePath(): string {
  return path.join(os.homedir(), ".openpond", "openpond-app", "token");
}

async function readToken(): Promise<string | null> {
  try {
    return (await fs.readFile(tokenFilePath(), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  server: string,
  token: string,
  route: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${server}${route}`, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : response.statusText;
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function health(server: string): Promise<boolean> {
  try {
    const response = await fetch(`${server}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function repoRoot(): string {
  return path.resolve(__dirname, "../../..");
}

async function startServer(onLog: (line: string) => void): Promise<string> {
  const root = repoRoot();
  const configuredRunner = process.env.OPENPOND_SERVER_RUNNER;
  const configuredArgs = parseConfiguredServerArgs(process.env.OPENPOND_SERVER_ARGS);
  const sourceMode = !configuredRunner && path.basename(__dirname) === "src";
  const serverEntry = path.join(root, "apps", "server", sourceMode ? "src/index.ts" : "dist/index.js");
  const command = configuredRunner ?? process.env.OPENPOND_NODE_BINARY ?? process.execPath;
  const args = configuredRunner
    ? configuredArgs
    : sourceMode
      ? [createRequire(import.meta.url).resolve("tsx/cli"), serverEntry]
      : [serverEntry];
  const child = spawn(command, args, {
    cwd: process.env.OPENPOND_SERVER_CWD || root,
    env: process.env,
    detached: process.platform !== "win32",
  });
  serverProcess = child;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const parser = createReadyLineParser<{ url?: string }>("OPENPOND_APP_SERVER_READY ", (payload) => {
      finish(payload.url || "http://127.0.0.1:17874");
    });
    const timer = setTimeout(() => fail(new Error("server start timed out")), 15_000);
    const onStdout = (chunk: Buffer) => {
      try {
        parser.push(chunk.toString("utf8"));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) onLog(text);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      parser.flush();
      fail(new Error(`server exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function parseConfiguredServerArgs(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Report one stable configuration error below.
  }
  throw new Error("OPENPOND_SERVER_ARGS must be a JSON string array");
}

export async function ensureServer(
  options: TerminalConnectionOptions,
  onLog: (line: string) => void
): Promise<{ server: string; token: string }> {
  let server = options.server;
  if (!(await health(server))) {
    if (options.noServerStart) throw new Error(`No server is listening at ${server}`);
    try {
      server = await startServer(onLog);
    } catch (error) {
      await stopManagedServer();
      throw error;
    }
  }
  const token = await readToken();
  if (!token) throw new Error("Missing OpenPond App capability token");
  return { server, token };
}

export function stopManagedServer(): Promise<void> {
  if (stopServerPromise) return stopServerPromise;
  const child = serverProcess;
  serverProcess = null;
  if (!child) return Promise.resolve();
  stopServerPromise = stopTerminalProcessTree(child).finally(() => {
    stopServerPromise = null;
  });
  return stopServerPromise;
}

export async function stopTerminalProcessTree(
  child: ChildProcessWithoutNullStreams,
  options: { gracefulTimeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<void> {
  terminateProcessTree(child, "SIGTERM");
  if (await waitForExit(child, options.gracefulTimeoutMs ?? 5_000)) return;
  terminateProcessTree(child, "SIGKILL");
  if (!(await waitForExit(child, options.killTimeoutMs ?? 2_000))) {
    throw new Error(`terminal-owned server process tree ${child.pid ?? "unknown"} did not exit`);
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
    spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
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
