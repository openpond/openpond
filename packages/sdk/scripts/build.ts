#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    index: path.join(root, "src/index.ts"),
    actions: path.join(root, "src/actions.ts"),
    "actions-local": path.join(root, "src/actions-local.ts"),
    "project-actions": path.join(root, "src/project-actions.ts"),
    "profile-actions": path.join(root, "src/profile-actions.ts"),
    workflows: path.join(root, "src/workflows.ts"),
    refiner: path.join(root, "src/refiner.ts"),
    "model-projects": path.join(root, "src/model-projects.ts"),
    training: path.join(root, "src/training.ts"),
  },
  outdir: dist,
  bundle: true,
  platform: "node",
  target: "node22.14",
  format: "esm",
  legalComments: "none",
  external: ["esbuild", "zod"],
  sourcemap: true,
  logLevel: "info",
});

await run(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "--build", "tsconfig.build.json", "--force"]);

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
