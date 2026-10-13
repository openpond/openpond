#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { withBuildLock } from "../../../scripts/build/build-lock.ts";
import { incrementalEmit } from "../../../scripts/build/incremental-emit.ts";
import { publishBuild, stageEmit } from "../../../scripts/build/publish.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const staging = path.join(root, "node_modules", ".cache", `harness-dist-${randomUUID()}`);

await withBuildLock(path.join(root, "node_modules/.cache/build.lock"), async () => {
  await mkdir(staging, { recursive: true });
  try {
    await stageEmit(await incrementalEmit(root), staging, dist);
    const runtime = await build({
      stdin: {
        contents:
          'export * from "./source-runtime.js"; export * from "./source-execution.js"; export * from "./source-package.js";',
        resolveDir: path.join(root, "src"),
        sourcefile: "harness-runtime.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      minify: true,
      legalComments: "inline",
    });
    const source = runtime.outputFiles[0]?.text;
    if (!source) throw new Error("Harness runtime distribution was not generated.");
    const hash = createHash("sha256").update(source).digest("hex");
    await writeFile(
      path.join(staging, "runtime-source.js"),
      `export const harnessRuntimeModuleSource = ${JSON.stringify(source)};\nexport const harnessRuntimeModuleSha256 = ${JSON.stringify(hash)};\n`,
    );
    await writeFile(
      path.join(staging, "types/runtime-source.d.ts"),
      "export declare const harnessRuntimeModuleSource: string;\nexport declare const harnessRuntimeModuleSha256: string;\n",
    );
    await publishBuild(staging, dist);
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
});
