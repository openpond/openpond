import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { runProcessCommand } from "../apps/cli/src/process-runner";

type PackResult = {
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: Array<{ path: string; size: number }>;
};

type ReadyPayload = {
  mode: "serve" | "web";
  url: string;
  webUrl: string | null;
  storePath: string;
};

const MiB = 1024 * 1024;
// Keep a broad guard against accidentally publishing an entire source tree.
// Vite's hashed, code-split assets legitimately fluctuate as lazy routes evolve,
// so this should not act as a per-feature file-count ratchet.
const MAX_NPM_PACKAGE_FILES = 500;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoots: string[] = [];

try {
  console.log(JSON.stringify({ npm: await checkNpmPackage() }, null, 2));
} finally {
  await Promise.all(tempRoots.map((directory) => rm(directory, { recursive: true, force: true })));
}

async function checkNpmPackage() {
  requireFile(path.join(root, "apps", "cli", "dist", "cli.js"));
  requireFile(path.join(root, "apps", "cli", "dist", "web", "index.html"));
  const packDir = await tempDir("openpond-cli-pack-");
  const pack = await command("npm", [
    "pack",
    path.join(root, "apps", "cli"),
    "--pack-destination",
    packDir,
    "--json",
  ]);
  const result = (JSON.parse(pack.stdout) as PackResult[])[0];
  if (!result) throw new Error("npm pack did not return package metadata");
  const tarballPath = path.join(packDir, result.filename);
  const tarballSha256 = createHash("sha256").update(await readFile(tarballPath)).digest("hex");

  enforce("npm packed bytes", result.size, 8 * MiB);
  enforce("npm unpacked bytes", result.unpackedSize, 32 * MiB);
  enforce("npm file count", result.entryCount, MAX_NPM_PACKAGE_FILES);
  const fileMap = new Map(result.files.map((file) => [file.path, file.size]));
  enforceRequiredFiles(fileMap, [
    "dist/cli.js",
    "dist/web/index.html",
    "LICENSE",
    "README.md",
    "docs/agent-edit-check-status-json.md",
  ]);
  enforce("npm CLI entry bytes", fileMap.get("dist/cli.js")!, 64 * 1024);

  const consumer = await tempDir("openpond-cli-consumer-");
  await writeFile(path.join(consumer, "package.json"), '{"private":true}\n', "utf8");
  await command("npm", [
    "install",
    "--prefix",
    consumer,
    tarballPath,
    "--no-audit",
    "--no-fund",
  ]);
  for (const unsupportedDependency of ["sqlite3", "better-sqlite3"]) {
    if (existsSync(path.join(consumer, "node_modules", unsupportedDependency))) {
      throw new Error(`npm consumer unexpectedly installed ${unsupportedDependency}`);
    }
  }
  const audit = await command("npm", ["audit", "--prefix", consumer, "--omit=dev", "--json"]);
  const auditPayload = JSON.parse(audit.stdout) as {
    metadata?: { vulnerabilities?: Record<string, number> };
  };
  const vulnerabilities = auditPayload.metadata?.vulnerabilities ?? {};
  if ((vulnerabilities.high ?? 0) > 0 || (vulnerabilities.critical ?? 0) > 0) {
    throw new Error(`npm consumer audit failed: ${JSON.stringify(vulnerabilities)}`);
  }
  const cli = path.join(consumer, "node_modules", "openpond", "dist", "cli.js");
  const runtime = await checkRunnableDistribution("node", [cli]);
  const installed = await checkInstalledEntrypoints({
    consumer,
    tarballPath,
    version: result.version,
  });
  const ephemeral = await checkEphemeralEntrypoints(tarballPath, result.version);
  return {
    tarballSha256,
    packedBytes: result.size,
    unpackedBytes: result.unpackedSize,
    fileCount: result.entryCount,
    entryBytes: fileMap.get("dist/cli.js"),
    auditVulnerabilities: vulnerabilities,
    installed,
    ephemeral,
    ...runtime,
  };
}

async function checkInstalledEntrypoints(input: {
  consumer: string;
  tarballPath: string;
  version: string;
}): Promise<{ localBins: string[]; globalBins: string[]; tui: "passed"; pty: "passed" }> {
  const binNames = ["openpond", "openpond-code", "op"];
  for (const binName of binNames) {
    await assertVersionOutput(
      installedBinPath(path.join(input.consumer, "node_modules", ".bin"), binName),
      input.version,
    );
  }

  const globalPrefix = await tempDir("openpond-cli-global-");
  await command("npm", [
    "install",
    "--global",
    "--prefix",
    globalPrefix,
    input.tarballPath,
    "--no-audit",
    "--no-fund",
  ]);
  const globalBinRoot = process.platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin");
  for (const binName of binNames) {
    await assertVersionOutput(installedBinPath(globalBinRoot, binName), input.version);
  }

  const tuiHome = await tempDir("openpond-cli-tui-home-");
  const tui = await command(
    installedBinPath(globalBinRoot, "openpond"),
    ["tui", "--server", "http://127.0.0.1:0"],
    {
    cwd: await tempDir("openpond-cli-tui-cwd-"),
    env: {
      HOME: tuiHome,
      OPENPOND_APP_HOME: path.join(tuiHome, ".openpond", "openpond-app"),
      USERPROFILE: tuiHome,
    },
    stdin: "/exit\n",
    timeoutMs: 30_000,
    },
  );
  if (!tui.stdout.includes("OpenPond")) {
    throw new Error(`installed TUI did not render its heading: ${tui.stderr || tui.stdout}`);
  }

  const globalPackageRoot = process.platform === "win32"
    ? path.join(globalPrefix, "node_modules", "openpond")
    : path.join(globalPrefix, "lib", "node_modules", "openpond");
  const pty = await command(process.execPath, [
    "-e",
    [
      `const nodePty = require(${JSON.stringify(path.join(globalPackageRoot, "node_modules", "node-pty"))});`,
      "const terminal = nodePty.spawn(process.execPath, ['-e', 'process.stdout.write(\\\"openpond-pty-ok\\\")'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });",
      "let output = '';",
      "terminal.onData((chunk) => { output += chunk; });",
      "terminal.onExit(({ exitCode }) => { if (exitCode !== 0 || output !== 'openpond-pty-ok') process.exit(1); });",
    ].join("\n"),
  ]);
  if (pty.stderr.trim()) throw new Error(`installed node-pty proof wrote stderr: ${pty.stderr}`);

  return { localBins: binNames, globalBins: binNames, tui: "passed", pty: "passed" };
}

async function checkEphemeralEntrypoints(
  tarballPath: string,
  version: string,
): Promise<{ npx: "passed"; npxWebLaunch: "passed" | "skipped-windows"; pnpmDlx: "passed" }> {
  const cwd = await tempDir("openpond-cli-ephemeral-cwd-");
  const npx = await command("npx", [
    "--yes",
    `--package=${tarballPath}`,
    "openpond",
    "--version",
  ], { cwd });
  assertVersion(npx.stdout, version, "npx");

  const pnpmDlx = await command("pnpm", ["dlx", tarballPath, "--version"], { cwd });
  assertVersion(pnpmDlx.stdout, version, "pnpm dlx");
  const npxWebLaunch = await checkDefaultNpxWebLaunch(tarballPath);
  return { npx: "passed", npxWebLaunch, pnpmDlx: "passed" };
}

async function checkDefaultNpxWebLaunch(
  tarballPath: string,
): Promise<"passed" | "skipped-windows"> {
  if (process.platform === "win32") return "skipped-windows";

  const cwd = await tempDir("openpond-cli-npx-web-cwd-");
  const userHome = await tempDir("openpond-cli-npx-web-user-home-");
  const appHome = path.join(userHome, ".openpond", "openpond-app");
  await mkdir(appHome, { recursive: true });
  const browserBin = await tempDir("openpond-cli-browser-bin-");
  const browserCapture = path.join(browserBin, "browser-url.txt");
  const browserCommand = path.join(browserBin, process.platform === "darwin" ? "open" : "xdg-open");
  await writeFile(browserCommand, [
    "#!/bin/sh",
    "set -eu",
    "printf '%s' \"$1\" > \"$OPENPOND_BROWSER_CAPTURE_FILE\"",
    "",
  ].join("\n"), "utf8");
  await chmod(browserCommand, 0o755);

  const beforeCwd = await readdir(cwd);
  const child = spawn("npx", [
    "--yes",
    `--package=${tarballPath}`,
    "openpond",
    "--port",
    "0",
  ], {
    cwd,
    env: {
      ...process.env,
      HOME: userHome,
      OPENPOND_APP_HOME: appHome,
      OPENPOND_BROWSER_CAPTURE_FILE: browserCapture,
      OPENPOND_FORCE_EMBEDDED_COMPANIONS: "1",
      PATH: `${browserBin}${path.delimiter}${process.env.PATH ?? ""}`,
      USERPROFILE: userHome,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });

  let serverUrl = "";
  try {
    const payload = await waitForReady(() => stdout, () => stderr, child, 30_000);
    if (payload.mode !== "web") {
      throw new Error(`bare npx launch selected ${payload.mode} instead of web mode`);
    }
    if (payload.webUrl !== null) {
      throw new Error("bare npx launch leaked its authenticated URL in the readiness payload");
    }
    if (!(await waitForPath(browserCapture, 5_000))) {
      throw new Error(`bare npx launch did not hand a URL to the system browser: ${stderr || stdout}`);
    }

    const browserUrlText = await readFile(browserCapture, "utf8");
    const browserUrl = new URL(browserUrlText);
    const fragment = new URLSearchParams(browserUrl.hash.slice(1));
    serverUrl = fragment.get("openpondServerUrl") ?? "";
    const token = fragment.get("openpondToken") ?? "";
    if (!serverUrl || !token) {
      throw new Error("browser handoff URL did not contain the server URL and capability token");
    }
    if (new URL(serverUrl).origin !== browserUrl.origin || new URL(payload.url).origin !== browserUrl.origin) {
      throw new Error(`browser handoff origin did not match server readiness: ${browserUrl.origin} vs ${payload.url}`);
    }
    if (`${stdout}\n${stderr}`.includes(token) || stdout.includes("openpondToken")) {
      throw new Error("bare npx launch exposed its capability token in normal command output");
    }

    const renderer = await fetch(serverUrl);
    const html = await renderer.text();
    if (!renderer.ok || !html.includes("<!doctype html>")) {
      throw new Error(`bare npx launch returned ${renderer.status} without the built renderer`);
    }
    const bootstrap = await fetch(`${serverUrl}/v1/bootstrap?ensureProfile=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!bootstrap.ok) {
      throw new Error(`browser capability token failed bootstrap authentication: ${bootstrap.status}`);
    }
    if (!(await waitForPath(payload.storePath, 2_000))) {
      throw new Error(`bare npx launch did not create its SQLite store at ${payload.storePath}`);
    }
    const relativeStorePath = path.relative(appHome, payload.storePath);
    if (relativeStorePath.startsWith("..") || path.isAbsolute(relativeStorePath)) {
      throw new Error(`bare npx launch wrote its SQLite store outside app home: ${payload.storePath}`);
    }
    if ((await readdir(appHome)).length === 0) {
      throw new Error("bare npx launch did not persist its app state");
    }
    if (JSON.stringify(await readdir(cwd)) !== JSON.stringify(beforeCwd)) {
      throw new Error("bare npx launch modified the invocation working directory");
    }
  } finally {
    await stopProcess(child);
  }

  if (serverUrl && await canFetch(serverUrl)) {
    throw new Error("bare npx launch left its local server running after shutdown");
  }
  if (JSON.stringify(await readdir(cwd)) !== JSON.stringify(beforeCwd)) {
    throw new Error("bare npx launch modified the invocation working directory during shutdown");
  }
  return "passed";
}

function installedBinPath(binRoot: string, binName: string): string {
  return path.join(binRoot, process.platform === "win32" ? `${binName}.cmd` : binName);
}

async function assertVersionOutput(binPath: string, version: string): Promise<void> {
  const result = await command(binPath, ["--version"]);
  assertVersion(result.stdout, version, binPath);
}

function assertVersion(stdout: string, version: string, label: string): void {
  if (stdout.trim() !== version) {
    throw new Error(`${label} returned ${JSON.stringify(stdout.trim())}; expected ${version}`);
  }
}

async function checkRunnableDistribution(commandName: string, prefixArgs: string[]) {
  const cwd = await tempDir("openpond-cli-cwd-");
  const appHome = await tempDir("openpond-cli-home-");
  const env = {
    OPENPOND_APP_HOME: appHome,
    OPENPOND_FORCE_EMBEDDED_COMPANIONS: "1",
  };
  const durations: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const started = performance.now();
    const version = await command(commandName, [...prefixArgs, "--version"], { cwd, env });
    durations.push(performance.now() - started);
    if (!/^\d+\.\d+\.\d+/.test(version.stdout.trim())) {
      throw new Error(`unexpected CLI version output: ${version.stdout.trim()}`);
    }
  }
  const versionP95Ms = percentile(durations, 0.95);
  reportBudget("CLI version cold-start p95 ms", versionP95Ms, 750);

  const terminal = await command(commandName, [...prefixArgs, "__terminal", "help"], { cwd, env });
  if (!terminal.stdout.includes("Usage: openpond-app chat")) {
    throw new Error("embedded terminal companion did not print its usage contract");
  }
  const server = await liveServer(commandName, [...prefixArgs, "serve", "--port", "0"], cwd, env);
  writePersistenceMarker(server.storePath);
  const ui = await liveServer(commandName, [...prefixArgs, "ui", "--no-open", "--port", "0"], cwd, env);
  if (ui.storePath !== server.storePath) {
    throw new Error(`npm CLI restart changed store path: ${server.storePath} -> ${ui.storePath}`);
  }
  assertPersistenceMarker(ui.storePath);
  return {
    versionP95Ms,
    serverReadyMs: server.readyMs,
    uiReadyMs: ui.readyMs,
    sqlitePersistence: "passed",
  };
}

async function liveServer(
  commandName: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ readyMs: number; storePath: string }> {
  const started = performance.now();
  const child = spawn(commandName, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
  try {
    const payload = await waitForReady(() => stdout, () => stderr, child, 15_000);
    const readyMs = performance.now() - started;
    reportBudget(`${payload.mode} ready ms`, readyMs, 10_000);
    if (!(await waitForPath(payload.storePath, 2_000))) {
      throw new Error(`${payload.mode} did not create its SQLite store at ${payload.storePath}`);
    }
    if (payload.mode === "web") {
      const response = await fetch(payload.url);
      const html = await response.text();
      if (!response.ok || !html.includes("<!doctype html>")) {
        throw new Error(`web mode returned ${response.status} without the built renderer`);
      }
    }
    return { readyMs, storePath: payload.storePath };
  } finally {
    await stopProcess(child);
  }
}

function writePersistenceMarker(filename: string): void {
  const database = new DatabaseSync(filename, { timeout: 1_000 });
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS openpond_distribution_check (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    database.prepare(
      "INSERT OR REPLACE INTO openpond_distribution_check (id, value) VALUES (?, ?)",
    ).run(1, "persisted-across-npm-cli-restart");
  } finally {
    database.close();
  }
}

function assertPersistenceMarker(filename: string): void {
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 1_000 });
  try {
    const health = database.prepare("PRAGMA quick_check").get() as { quick_check?: unknown };
    const marker = database.prepare(
      "SELECT value FROM openpond_distribution_check WHERE id = ?",
    ).get(1) as { value?: unknown } | undefined;
    if (health.quick_check !== "ok" || marker?.value !== "persisted-across-npm-cli-restart") {
      throw new Error(`npm CLI SQLite restart proof failed: ${JSON.stringify({ health, marker })}`);
    }
  } finally {
    database.close();
  }
}

async function waitForReady(
  stdout: () => string,
  stderr: () => string,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<ReadyPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = stdout().split(/\r?\n/).find((item) => item.startsWith("OPENPOND_APP_SERVER_READY "));
    if (line) return JSON.parse(line.slice("OPENPOND_APP_SERVER_READY ".length)) as ReadyPayload;
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`CLI server exited before ready: ${stderr() || stdout()}`);
    }
    await delay(25);
  }
  throw new Error(`CLI server readiness timed out: ${stderr() || stdout()}`);
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await delay(25);
  }
  return existsSync(filePath);
}

async function canFetch(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  signalTree(child.pid, "SIGTERM");
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const graceful = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]);
  if (!graceful) {
    signalTree(child.pid, "SIGKILL");
    await closed;
  }
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function command(
  commandName: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  } = {},
) {
  const result = await runProcessCommand(commandName, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: 4 * MiB,
  });
  if (result.code !== 0) throw new Error(`${commandName} failed: ${result.stderr || result.stdout}`);
  return result;
}

function enforceRequiredFiles(files: Map<string, number>, required: string[]): void {
  for (const file of required) {
    if (!files.has(file)) throw new Error(`npm package is missing ${file}`);
  }
}

function enforce(label: string, actual: number, maximum: number): void {
  if (!Number.isFinite(actual) || actual > maximum) {
    throw new Error(`${label} exceeded: ${Math.round(actual)} > ${maximum}`);
  }
}

function reportBudget(label: string, actual: number, maximum: number): void {
  if (!Number.isFinite(actual)) throw new Error(`${label} was not finite`);
  if (actual > maximum) {
    console.warn(`::warning::${label} exceeded on this runner: ${Math.round(actual)} > ${maximum}`);
  }
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function boundedAppend(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > 512 * 1024 ? combined.slice(-512 * 1024) : combined;
}

function requireFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`required distribution file is missing: ${filePath}`);
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempRoots.push(directory);
  return directory;
}
