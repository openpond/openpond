import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AppPreferencesSchema } from "@openpond/contracts";
import { afterEach, describe, expect, test } from "bun:test";

import { api, type ClientConnection } from "../apps/web/src/api";
import { WorkspaceLspManager } from "../apps/server/src/workspace/workspace-lsp";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createFakeLspServer(): Promise<{ command: string; logPath: string }> {
  const dir = await createTempDir("openpond-fake-lsp-");
  const scriptPath = path.join(dir, "fake-lsp.cjs");
  const command = process.platform === "win32" ? path.join(dir, "fake-lsp.cmd") : scriptPath;
  const logPath = path.join(dir, "fake-lsp.log");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const logPath = process.env.OPENPOND_FAKE_LSP_LOG;
function log(line) {
  if (logPath) fs.appendFileSync(logPath, line + "\\n");
}
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write("Content-Length: " + body.byteLength + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
function diagnostic(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        severity: 2,
        message: "fake diagnostic",
        source: "fake-lsp"
      }]
    }
  });
}
let buffer = Buffer.alloc(0);
function handle(message) {
  if (message.id !== undefined && message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          documentSymbolProvider: true
        }
      }
    });
    return;
  }
  if (message.method === "textDocument/didOpen") {
    const uri = message.params && message.params.textDocument && message.params.textDocument.uri;
    if (uri) setTimeout(() => diagnostic(uri), 5);
    return;
  }
  if (message.method === "textDocument/didChange") {
    const uri = message.params && message.params.textDocument && message.params.textDocument.uri;
    if (uri) setTimeout(() => diagnostic(uri), 5);
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}
function parse() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.byteLength < end) return;
    const body = buffer.slice(start, end).toString("utf8");
    buffer = buffer.slice(end);
    handle(JSON.parse(body));
  }
}
log("start " + process.pid);
process.stderr.write("fake stderr ".repeat(200));
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parse();
});
process.on("SIGTERM", () => {
  log("sigterm " + process.pid);
  process.exit(0);
});
process.on("exit", () => log("exit " + process.pid));
`,
    "utf8",
  );
  if (process.platform === "win32") {
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  }
  await chmod(scriptPath, 0o755);
  await chmod(command, 0o755);
  return { command, logPath };
}

async function createTypescriptRepo(prefix: string): Promise<string> {
  const repoPath = await createTempDir(prefix);
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "package.json"), '{"private":true}\n', "utf8");
  await writeFile(path.join(repoPath, "src", "file.ts"), "export const value = 1;\n", "utf8");
  return repoPath;
}

function preferencesFor(command: string) {
  return AppPreferencesSchema.parse({
    editor: {
      languageServers: "auto",
      languages: {
        typescript: { mode: "custom", customCommand: command },
      },
    },
  });
}

async function touchTypescriptFile(manager: WorkspaceLspManager, repoPath: string, command: string) {
  return manager.touchFile({
    appId: path.basename(repoPath),
    repoPath,
    path: "src/file.ts",
    content: "export const value = 2;\n",
    preferences: preferencesFor(command),
    waitForDiagnostics: true,
  });
}

async function waitForLogCount(logPath: string, pattern: RegExp, minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const count = log.split("\n").filter((line) => pattern.test(line)).length;
    if (count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const log = await readFile(logPath, "utf8").catch(() => "");
  throw new Error(`Timed out waiting for ${minimum} log lines matching ${pattern}:\\n${log}`);
}

describe("workspace LSP manager lifecycle", () => {
  test("passes AbortSignal through workspace LSP touch API calls", async () => {
    const connection: ClientConnection = {
      serverUrl: "http://127.0.0.1:18181",
      token: "test-token",
      platform: "linux",
    };
    let capturedSignal: AbortSignal | null = null;
    globalThis.fetch = (async (_input, init) => {
      capturedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
      return await new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          "abort",
          () => reject(capturedSignal?.reason instanceof Error ? capturedSignal.reason : new Error("Aborted")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const request = api.workspaceLspTouch(
      connection,
      "app-1",
      { path: "src/file.ts", waitForDiagnostics: true },
      { signal: controller.signal },
    );
    await Promise.resolve();
    expect(capturedSignal).toBe(controller.signal);

    controller.abort(new Error("Aborted"));
    await expect(request).rejects.toThrow("Aborted");
  });

  test("rejects oversized LSP document text before spawning a language server", async () => {
    const { command, logPath } = await createFakeLspServer();
    const repoPath = await createTypescriptRepo("openpond-lsp-large-");
    const manager = new WorkspaceLspManager();
    const originalLogPath = process.env.OPENPOND_FAKE_LSP_LOG;
    process.env.OPENPOND_FAKE_LSP_LOG = logPath;

    try {
      await expect(
        manager.touchFile({
          appId: "large-file",
          repoPath,
          path: "src/file.ts",
          content: "x".repeat(512 * 1024 + 1),
          preferences: preferencesFor(command),
          waitForDiagnostics: false,
        }),
      ).rejects.toThrow("the limit is 524288 bytes");
      const log = await readFile(logPath, "utf8").catch(() => "");
      expect(log).not.toContain("start ");
    } finally {
      manager.shutdown();
      if (originalLogPath === undefined) delete process.env.OPENPOND_FAKE_LSP_LOG;
      else process.env.OPENPOND_FAKE_LSP_LOG = originalLogPath;
    }
  });

  test("caches executable resolution per repo and language until shutdown", async () => {
    const { command } = await createFakeLspServer();
    const repoPath = await createTypescriptRepo("openpond-lsp-cache-");
    const manager = new WorkspaceLspManager();
    const preferences = preferencesFor(command);

    try {
      const first = await manager.settingsStatus({ preferences, repoPath });
      expect(first.languages.find((language) => language.language === "typescript")).toMatchObject({
        status: "found",
        command,
      });

      await rm(command, { force: true });
      const cached = await manager.settingsStatus({ preferences, repoPath });
      expect(cached.languages.find((language) => language.language === "typescript")).toMatchObject({
        status: "found",
        command,
      });

      manager.shutdown();
      const afterRestart = await manager.settingsStatus({ preferences, repoPath });
      expect(afterRestart.languages.find((language) => language.language === "typescript")).toMatchObject({
        status: "missing",
        command: null,
      });
    } finally {
      manager.shutdown();
    }
  });

  test("caps active clients, captures bounded stderr, and evicts idle real LSP subprocesses", async () => {
    const { command, logPath } = await createFakeLspServer();
    let nowMs = 1_000;
    const manager = new WorkspaceLspManager({
      idleTimeoutMs: 1_000,
      maxClients: 2,
      nowMs: () => nowMs,
      stderrMaxChars: 96,
    });
    const originalLogPath = process.env.OPENPOND_FAKE_LSP_LOG;
    process.env.OPENPOND_FAKE_LSP_LOG = logPath;

    try {
      const repos = await Promise.all([
        createTypescriptRepo("openpond-lsp-repo-a-"),
        createTypescriptRepo("openpond-lsp-repo-b-"),
        createTypescriptRepo("openpond-lsp-repo-c-"),
      ]);

      const first = await touchTypescriptFile(manager, repos[0]!, command);
      nowMs += 100;
      await touchTypescriptFile(manager, repos[1]!, command);
      let status = manager.runtimeStatus();

      expect(first.diagnostics[0]).toMatchObject({ message: "fake diagnostic", source: "fake-lsp" });
      expect(status.clients).toHaveLength(2);
      expect(status.clients[0]?.stderrTail.length).toBeLessThanOrEqual(96);
      expect(status.clients[0]?.stderrTail).toContain("fake stderr");

      nowMs += 100;
      await touchTypescriptFile(manager, repos[2]!, command);
      status = manager.runtimeStatus();
      expect(status.clients).toHaveLength(2);
      await waitForLogCount(logPath, /^sigterm /, 1);

      nowMs += 2_000;
      expect(manager.runtimeStatus().clients).toHaveLength(0);
      await waitForLogCount(logPath, /^sigterm /, 3);
    } finally {
      manager.shutdown();
      if (originalLogPath === undefined) delete process.env.OPENPOND_FAKE_LSP_LOG;
      else process.env.OPENPOND_FAKE_LSP_LOG = originalLogPath;
    }
  });
});
