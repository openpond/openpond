import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TerminalConnectionOptions = {
  server: string;
  noServerStart: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverProcess: ChildProcessWithoutNullStreams | null = null;

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
  const serverEntry = path.join(root, "apps", "server", "src", "index.ts");
  serverProcess = spawn(process.env.BUN_BINARY || "bun", [serverEntry], {
    cwd: root,
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(
      () => reject(new Error("server start timed out")),
      15000
    );
    serverProcess?.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith("OPENPOND_APP_SERVER_READY ")) continue;
        clearTimeout(timer);
        const payload = JSON.parse(
          line.slice("OPENPOND_APP_SERVER_READY ".length)
        ) as { url?: string };
        resolve(payload.url || "http://127.0.0.1:17874");
      }
    });
    serverProcess?.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) onLog(text);
    });
    serverProcess?.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function ensureServer(
  options: TerminalConnectionOptions,
  onLog: (line: string) => void
): Promise<{ server: string; token: string }> {
  let server = options.server;
  if (!(await health(server))) {
    if (options.noServerStart) throw new Error(`No server is listening at ${server}`);
    server = await startServer(onLog);
  }
  const token = await readToken();
  if (!token) throw new Error("Missing OpenPond App capability token");
  return { server, token };
}

export function stopManagedServer(): void {
  serverProcess?.kill("SIGTERM");
  serverProcess = null;
}
