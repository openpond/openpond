#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { withBuildLock } from "../../../scripts/build/build-lock.ts";
import { incrementalEmit } from "../../../scripts/build/incremental-emit.ts";
import { publishBuild, stageEmit } from "../../../scripts/build/publish.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist");
const dist = path.join(root, "node_modules/.cache", `sdk-dist-${randomUUID()}`);

await withBuildLock(path.join(root, "node_modules/.cache/build.lock"), async () => {
  try {
    await mkdir(dist, { recursive: true });

    await build({
      entryPoints: {
        "tool-learning": path.join(root, "src/tool-learning.ts"),
        "tool-learning-local-store": path.join(root, "src/tool-learning-local-store.ts"),
        "human-review": path.join(root, "src/human-review.ts"),
        "connected-evidence": path.join(root, "src/connected-evidence.ts"),
        "post-training": path.join(root, "src/post-training.ts"),
        "candidate-evaluations": path.join(root, "src/candidate-evaluations.ts"),
        "experiment-improvements": path.join(root, "src/experiment-improvements.ts"),
        "experiment-evaluation-schedules": path.join(
          root,
          "src/experiment-evaluation-schedules.ts",
        ),
        "advanced-refiner-evaluations": path.join(root, "src/advanced-refiner-evaluations.ts"),
        experiments: path.join(root, "src/experiments.ts"),
        "dataset-marketplace": path.join(root, "src/dataset-marketplace.ts"),
        "dataset-commerce": path.join(root, "src/dataset-commerce.ts"),
        "dataset-workspaces": path.join(root, "src/dataset-workspaces.ts"),
        "training-projects": path.join(root, "src/training-projects.ts"),
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
        errors: path.join(root, "src/errors.ts"),
        training: path.join(root, "src/training.ts"),
        "training-hardware": path.join(root, "src/training-hardware.ts"),
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

    // Splitting moves a repeated external wildcard barrel into a shared chunk.
    // Preserve its public runtime exports at both advertised entry points; their
    // emitted declarations expose the same portable Human contracts.
    for (const entry of ["human-review", "index"]) {
      const file = path.join(dist, `${entry}.js`);
      await writeFile(
        file,
        `${await readFile(file, "utf8")}\nexport * from "@openpond/evals/human-review";\n`,
      );
    }

    await stageEmit(
      await incrementalEmit(root, true),
      path.join(dist, "types"),
      path.join(target, "types"),
    );

    // The cloud implementation is bundled, not an installable runtime dependency.
    // Resolve its declarations within the emitted package so independent consumers
    // retain real sandbox types instead of unresolved imports becoming `any`.
    const declarations = path.join(dist, "types");
    for (const entry of await readdir(declarations, { recursive: true })) {
      if (!entry.endsWith(".d.ts")) continue;
      const file = path.join(declarations, entry);
      let source = await readFile(file, "utf8");
      for (const match of source.matchAll(/(["'])@openpond\/cloud\/([^"']+)\1/g)) {
        const target = path.join(declarations, "packages/cloud/src", match[2]);
        let resolved = `${target}.d.ts`;
        try {
          await access(resolved);
        } catch {
          resolved = path.join(target, "index.d.ts");
          await access(resolved);
        }
        let relative = path
          .relative(path.dirname(file), resolved)
          .split(path.sep)
          .join("/")
          .replace(/\.d\.ts$/, ".js");
        if (!relative.startsWith(".")) relative = `./${relative}`;
        source = source.replaceAll(match[0], JSON.stringify(relative));
      }
      await writeFile(file, source);
    }

    for (const entry of await readdir(dist)) {
      if (!entry.endsWith(".js.map")) continue;
      const file = path.join(dist, entry);
      const map = JSON.parse(await readFile(file, "utf8"));
      map.sources = map.sources.map((source: string) =>
        path.relative(target, path.resolve(dist, source)).split(path.sep).join("/"),
      );
      await writeFile(file, JSON.stringify(map));
    }
    await publishBuild(dist, target);
  } finally {
    await rm(dist, { force: true, recursive: true });
  }
});
