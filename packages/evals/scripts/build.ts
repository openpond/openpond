#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const staging = path.join(root, "node_modules", ".cache", `evals-dist-${randomUUID()}`);

await mkdir(staging, { recursive: true });
try {
  await run(process.execPath, [
    createRequire(import.meta.url).resolve("typescript/bin/tsc"),
    "--project",
    "tsconfig.build.json",
    "--outDir",
    staging,
    "--declarationDir",
    path.join(staging, "types"),
    "--tsBuildInfoFile",
    path.join(staging, ".tsbuildinfo"),
  ]);
  await publishBuild(staging, dist);
} finally {
  await rm(staging, { force: true, recursive: true });
}

async function publishBuild(source: string, target: string): Promise<void> {
  const stagedFiles = (await filesBelow(source))
    .filter((file) => file !== ".tsbuildinfo")
    .sort((left, right) => publishPriority(left) - publishPriority(right) || left.localeCompare(right));
  const stagedSet = new Set(stagedFiles);
  await mkdir(target, { recursive: true });
  for (const relative of stagedFiles) {
    const destination = path.join(target, relative);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, relative), temporary);
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  for (const relative of await filesBelow(target)) {
    if (!stagedSet.has(relative)) await rm(path.join(target, relative), { force: true });
  }
}

function publishPriority(relative: string): number {
  if (relative === "index.js") return 3;
  if (relative.endsWith("/index.js")) return 2;
  if (relative === "types/index.d.ts" || relative === "types/index.d.ts.map") return 5;
  if (relative.endsWith("/index.d.ts") || relative.endsWith("/index.d.ts.map")) return 4;
  return 1;
}

async function filesBelow(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}
