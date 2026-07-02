import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReadyPayload = {
  url?: string;
  tokenFile?: string;
};

type ServerConnection = {
  serverUrl: string;
  token: string;
  process: ChildProcessWithoutNullStreams | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const defaultServerUrl = "http://127.0.0.1:17874";
const defaultWebUrl = `http://127.0.0.1:${process.env.OPENPOND_WEB_PORT || "17876"}`;

function appDataDir(): string {
  return process.env.OPENPOND_APP_HOME || path.join(os.homedir(), ".openpond", "openpond-app");
}

function tokenFilePath(): string {
  return path.join(appDataDir(), "token");
}

function bunBinary(): string {
  if (process.env.BUN_BINARY) return process.env.BUN_BINARY;
  return process.versions.bun ? process.execPath : "bun";
}

function nodeBinary(): string {
  return process.env.OPENPOND_NODE_BINARY || process.env.NODE_BINARY || "node";
}

function buildServer(): void {
  const result = spawnSync(bunBinary(), ["run", "build:server"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`OpenPond App server build failed with code ${result.status ?? "unknown"}`);
  }
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

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<ReadyPayload> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (payload: ReadyPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("OpenPond App server did not start in time")), 15000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        console.log(line);
        if (line.startsWith("OPENPOND_APP_SERVER_READY ")) {
          finish(JSON.parse(line.slice("OPENPOND_APP_SERVER_READY ".length)) as ReadyPayload);
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      console.error(chunk.toString("utf8"));
    });
    child.once("exit", (code) => {
      fail(new Error(`OpenPond App server exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureServer(): Promise<ServerConnection> {
  const existingUrl = process.env.OPENPOND_SERVER_URL || defaultServerUrl;
  const existingToken = await readToken();
  const existingServerIsHealthy = await health(existingUrl);
  const explicitServerUrl = Boolean(process.env.OPENPOND_SERVER_URL);
  const shouldReuseExistingServer =
    existingToken && existingServerIsHealthy && (explicitServerUrl || process.env.OPENPOND_REUSE_SERVER === "1");
  if (shouldReuseExistingServer) {
    console.log(`Using OpenPond App server at ${existingUrl}`);
    return { serverUrl: existingUrl, token: existingToken, process: null };
  }
  if (existingServerIsHealthy && (explicitServerUrl || process.env.OPENPOND_REUSE_SERVER === "1")) {
    throw new Error(`Found OpenPond App server at ${existingUrl}, but no capability token was available at ${tokenFilePath()}`);
  }

  buildServer();

  const serverProcess = spawn(nodeBinary(), ["apps/server/dist/index.js", "--port", existingServerIsHealthy ? "0" : "17874"], {
    cwd: root,
    env: {
      ...process.env,
      OPENPOND_REMOTE_ACCESS_TARGET: process.env.OPENPOND_WEB_URL || defaultWebUrl,
    },
  });
  const ready = await waitForReady(serverProcess);
  const token = await readToken(ready.tokenFile);
  if (!token) {
    throw new Error(`OpenPond App server did not write a capability token at ${ready.tokenFile ?? tokenFilePath()}`);
  }
  return { serverUrl: ready.url || defaultServerUrl, token, process: serverProcess };
}

function shutdown(children: ChildProcessWithoutNullStreams[]): void {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const server = await ensureServer();
  const webProcess = spawn(bunBinary(), ["run", "--cwd", "apps/web", "dev"], {
    cwd: root,
    env: {
      ...process.env,
      VITE_OPENPOND_SERVER_URL: server.serverUrl,
      VITE_OPENPOND_TOKEN: server.token,
    },
    stdio: "inherit",
  });
  const children = [webProcess, server.process].filter((child): child is ChildProcessWithoutNullStreams => Boolean(child));

  console.log(`OpenPond web dev server will use ${server.serverUrl}`);

  process.on("SIGINT", () => {
    shutdown(children);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown(children);
    process.exit(0);
  });
  webProcess.once("exit", (code) => {
    shutdown(children.filter((child) => child !== webProcess));
    process.exit(code ?? 0);
  });
  server.process?.once("exit", (code) => {
    if (!webProcess.killed) webProcess.kill("SIGTERM");
    process.exit(code ?? 0);
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
