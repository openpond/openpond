#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const entryPoints = ["index", "harness", "tasksets", "graders", "runs", "conformance"];

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: Object.fromEntries(entryPoints.map((name) => [name, path.join(root, `src/${name}.ts`)])),
  outdir: dist,
  bundle: true,
  platform: "node",
  target: "node22.14",
  format: "esm",
  external: ["zod"],
  legalComments: "none",
  sourcemap: true,
  metafile: true,
  logLevel: "info",
});

await run(resolveTscBin(), ["--build", "tsconfig.build.json", "--force"]);

function resolveTscBin(): string {
  const candidates = [
    path.join(root, "node_modules/.bin/tsc"),
    path.resolve(root, "..", "..", "node_modules/.bin/tsc"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "tsc";
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
