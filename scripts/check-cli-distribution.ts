import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runProcessCommand } from "../apps/cli/src/process-runner";

type PackResult = {
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
const root = path.resolve(import.meta.dir, "..");
const archiveArg = valueAfter("--archive");
const tempRoots: string[] = [];

try {
  const npmMetrics = await checkNpmPackage();
  const archiveMetrics = archiveArg ? await checkCompiledArchive(path.resolve(archiveArg)) : null;
  console.log(JSON.stringify({ npm: npmMetrics, archive: archiveMetrics }, null, 2));
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

  enforce("npm packed bytes", result.size, 8 * MiB);
  enforce("npm unpacked bytes", result.unpackedSize, 32 * MiB);
  enforce("npm file count", result.entryCount, 250);
  const fileMap = new Map(result.files.map((file) => [file.path, file.size]));
  enforceRequiredFiles(fileMap, [
    "dist/cli.js",
    "dist/web/index.html",
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
    path.join(packDir, result.filename),
    "--no-audit",
    "--no-fund",
  ]);
  const cli = path.join(consumer, "node_modules", "openpond", "dist", "cli.js");
  const runtime = await checkRunnableDistribution("node", [cli]);
  return {
    packedBytes: result.size,
    unpackedBytes: result.unpackedSize,
    fileCount: result.entryCount,
    entryBytes: fileMap.get("dist/cli.js"),
    ...runtime,
  };
}

async function checkCompiledArchive(archivePath: string) {
  requireFile(archivePath);
  const archiveBytes = (await stat(archivePath)).size;
  const limits = process.platform === "darwin"
    ? { archive: 60 * MiB, extracted: 145 * MiB, binary: 120 * MiB }
    : { archive: 50 * MiB, extracted: 130 * MiB, binary: 110 * MiB };
  enforce("compiled archive bytes", archiveBytes, limits.archive);

  const extracted = await tempDir("openpond-cli-archive-");
  await command("tar", ["-xzf", archivePath, "-C", extracted]);
  const cli = path.join(extracted, "openpond");
  requireFile(cli);
  requireFile(path.join(extracted, "web", "index.html"));
  const op = await lstat(path.join(extracted, "op"));
  if (!op.isSymbolicLink()) throw new Error("compiled archive op alias must be a symlink");
  const binaryBytes = (await stat(cli)).size;
  enforce("compiled binary bytes", binaryBytes, limits.binary);

  const inventoryPath = path.join(extracted, "cli-release-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  let extractedBytes = 0;
  for (const item of inventory.files) {
    const contents = await readFile(path.join(extracted, item.path));
    extractedBytes += contents.byteLength;
    if (contents.byteLength !== item.bytes) throw new Error(`archive size mismatch for ${item.path}`);
    const hash = createHash("sha256").update(contents).digest("hex");
    if (hash !== item.sha256) throw new Error(`archive hash mismatch for ${item.path}`);
  }
  enforce("compiled extracted bytes", extractedBytes, limits.extracted);
  const runtime = await checkRunnableDistribution(cli, []);
  return { archiveBytes, extractedBytes, binaryBytes, fileCount: inventory.files.length, ...runtime };
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
  enforce("CLI version cold-start p95 ms", versionP95Ms, 750);

  const terminal = await command(commandName, [...prefixArgs, "__terminal", "help"], { cwd, env });
  if (!terminal.stdout.includes("Usage: openpond-app chat")) {
    throw new Error("embedded terminal companion did not print its usage contract");
  }
  const server = await liveServer(commandName, [...prefixArgs, "serve", "--port", "0"], cwd, env);
  const ui = await liveServer(commandName, [...prefixArgs, "ui", "--port", "0"], cwd, env);
  return { versionP95Ms, serverReadyMs: server.readyMs, uiReadyMs: ui.readyMs };
}

async function liveServer(
  commandName: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ readyMs: number }> {
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
    enforce(`${payload.mode} ready ms`, readyMs, 10_000);
    if (!(await waitForPath(payload.storePath, 2_000))) {
      throw new Error(`${payload.mode} did not create its SQLite store at ${payload.storePath}`);
    }
    if (payload.mode === "web") {
      if (!payload.webUrl) throw new Error("web mode did not return a web URL");
      const response = await fetch(payload.webUrl.split("#")[0]!);
      const html = await response.text();
      if (!response.ok || !html.includes("<!doctype html>")) {
        throw new Error(`web mode returned ${response.status} without the built renderer`);
      }
    }
    return { readyMs };
  } finally {
    await stopProcess(child);
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
    await Bun.sleep(25);
  }
  throw new Error(`CLI server readiness timed out: ${stderr() || stdout()}`);
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await Bun.sleep(25);
  }
  return existsSync(filePath);
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  signalTree(child.pid, "SIGTERM");
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const graceful = await Promise.race([closed.then(() => true), Bun.sleep(5_000).then(() => false)]);
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
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = await runProcessCommand(commandName, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    timeoutMs: 120_000,
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

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
