#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    "model-batch-review": path.join(root, "src/model-batch-review-contracts.ts"),
    "model-taskset-authoring": path.join(root, "src/model-taskset-authoring-contracts.ts"),
    training: path.join(root, "src/training.ts"),
    "training-bundle": path.join(root, "src/training-bundle.ts"),
    learning: path.join(root, "src/learning.ts"),
    "taskset-catalog": path.join(root, "src/taskset-catalog.ts"),
    "taskset-packages": path.join(root, "src/taskset-packages.ts"),
    "taskset-drafts": path.join(root, "src/taskset-drafts.ts"),
    "model-starters": path.join(root, "src/model-starters.ts"),
    "model-starter-catalog": path.join(root, "src/model-starter-catalog.ts"),
    "model-starter-attempts": path.join(root, "src/model-starter-attempts.ts"),
    "model-taskset-runs": path.join(root, "src/model-taskset-runs.ts"),
  },
  outdir: dist,
  bundle: true,
  // Keep shared schemas/authoring helpers single-instance across public entry
  // points when consumers import several SDK protocols in the same renderer.
  splitting: true,
  platform: "node",
  target: "node22.14",
  format: "esm",
  legalComments: "none",
  external: ["esbuild", "zod", "yaml", "@openpond/evals", "@openpond/evals/*"],
  sourcemap: true,
  logLevel: "info",
});

await run(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "--build", "tsconfig.build.json", "--force"]);

// The cloud implementation is bundled, not an installable runtime dependency.
// Resolve its declarations within the emitted package so independent consumers
// retain real sandbox types instead of unresolved imports becoming `any`.
const declarations = path.join(dist, "types");
for (const entry of await readdir(declarations, { recursive: true })) {
  if (!entry.endsWith(".d.ts")) continue;
  const file = path.join(declarations, entry);
  let source = await readFile(file, "utf8");
  for (const match of [...source.matchAll(/(["'])@openpond\/cloud\/([^"']+)\1/g)]) {
    const target = path.join(declarations, "packages/cloud/src", match[2]);
    let resolved = `${target}.d.ts`;
    try { await access(resolved); }
    catch { resolved = path.join(target, "index.d.ts"); await access(resolved); }
    let relative = path.relative(path.dirname(file), resolved).split(path.sep).join("/").replace(/\.d\.ts$/, ".js");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    source = source.replaceAll(match[0], JSON.stringify(relative));
  }
  await writeFile(file, source);
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
