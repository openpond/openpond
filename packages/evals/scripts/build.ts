#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

import { withBuildLock } from "../../../scripts/build/build-lock.ts";
import { incrementalEmit } from "../../../scripts/build/incremental-emit.ts";
import { publishBuild, stageEmit } from "../../../scripts/build/publish.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const staging = path.join(root, "node_modules", ".cache", `evals-dist-${randomUUID()}`);

await withBuildLock(path.join(root, "node_modules/.cache/build.lock"), async () => {
  await mkdir(staging, { recursive: true });
  try {
    await stageEmit(await incrementalEmit(root), staging, dist);
    const worker = await build({
      entryPoints: [path.join(root, "src/javascript-verifier-worker.ts")],
      bundle: true,
      platform: "node",
      target: "node22.14",
      format: "cjs",
      write: false,
      minify: true,
      legalComments: "none",
    });
    await writeProcessSource(
      "javascript-verifier-worker-source",
      "javascriptVerifierWorkerSource",
      worker.outputFiles[0]!.text,
    );
    await copyFile(
      path.join(root, "src/javascript-verifier-worker-source.d.ts"),
      path.join(staging, "types/javascript-verifier-worker-source.d.ts"),
    );
    const processHost = await build({
      entryPoints: [path.join(root, "src/javascript-isolate-process-entry.ts")],
      bundle: true,
      platform: "node",
      target: "node22.14",
      format: "cjs",
      write: false,
      minify: true,
      legalComments: "none",
    });
    await writeProcessSource(
      "javascript-isolate-process-source",
      "javascriptIsolateProcessSource",
      processHost.outputFiles[0]!.text,
    );
    await copyFile(
      path.join(root, "src/javascript-isolate-process-source.d.ts"),
      path.join(staging, "types/javascript-isolate-process-source.d.ts"),
    );
    const sqliteBinary = await readFile(
      createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
    );
    const compressedSqlite = brotliCompressSync(sqliteBinary, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    const binarySource = `import { brotliDecompressSync } from "node:zlib"; export const sqlWasmBinary = new Uint8Array(brotliDecompressSync(Buffer.from(${JSON.stringify(compressedSqlite.toString("base64"))}, "base64")));\n`;
    const sqlProcess = await build({
      entryPoints: [path.join(root, "src/sql-execution-process-entry.ts")],
      bundle: true,
      platform: "node",
      target: "node22.14",
      format: "esm",
      write: false,
      minify: true,
      legalComments: "inline",
      plugins: [
        {
          name: "sqlite-binary",
          setup(builder) {
            builder.onResolve({ filter: /sql-wasm-binary\.js$/ }, () => ({
              path: "sqlite-binary",
              namespace: "sqlite-binary",
            }));
            builder.onLoad({ filter: /.*/, namespace: "sqlite-binary" }, () => ({
              contents: binarySource,
              loader: "js",
            }));
          },
        },
      ],
    });
    await writeProcessSource(
      "sql-execution-process-source",
      "sqlExecutionProcessSource",
      sqlProcess.outputFiles[0]!.text,
    );
    await writeFile(path.join(staging, "sql-wasm-binary.js"), binarySource);
    for (const name of ["sql-execution-process-source", "sql-wasm-binary"])
      await copyFile(path.join(root, `src/${name}.d.ts`), path.join(staging, `types/${name}.d.ts`));
    await copyFile(
      path.join(root, "src/task-schema-meta-validator.js"),
      path.join(staging, "task-schema-meta-validator.js"),
    );
    await copyFile(
      path.join(root, "src/task-schema-meta-validator.d.ts"),
      path.join(staging, "types/task-schema-meta-validator.d.ts"),
    );
    await publishBuild(staging, dist);
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
});

async function writeProcessSource(file: string, exportName: string, source: string): Promise<void> {
  const compressed = brotliCompressSync(Buffer.from(source), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  await writeFile(
    path.join(staging, `${file}.js`),
    `import { brotliDecompressSync } from "node:zlib"; export const ${exportName} = brotliDecompressSync(Buffer.from(${JSON.stringify(compressed.toString("base64"))}, "base64")).toString("utf8");\n`,
  );
}
