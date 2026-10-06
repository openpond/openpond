import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { fromRoot } from "./shared-esbuild.js";
import { boundWasmMemory } from "./bounded-wasm-memory.js";

/** Embed trusted parser and calculation engine so packaged Desktop and the
 * hosted CLI need neither npm resolution nor an external spreadsheet program. */
export async function buildWorkbookInspector(): Promise<void> {
  const require = createRequire(fromRoot("apps/server/package.json"));
  const binary = Buffer.from(
    boundWasmMemory(
      await readFile(require.resolve("@ironcalc/wasm/wasm_bg.wasm")),
      1024,
    ),
  );
  const binarySource = `export const workbookEngineBinary = new Uint8Array(Buffer.from(${JSON.stringify(binary.toString("base64"))}, "base64"));`;
  const worker = await build({
    entryPoints: [
      fromRoot("apps/server/src/evaluations/workbook-inspector-worker.ts"),
    ],
    bundle: true,
    platform: "node",
    target: "node24.18",
    format: "cjs",
    minify: true,
    write: false,
    legalComments: "inline",
    plugins: [
      {
        name: "workbook-engine",
        setup(builder) {
          builder.onResolve({ filter: /workbook-engine-binary\.js$/ }, () => ({
            path: "binary",
            namespace: "workbook-engine",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "workbook-engine" },
            () => ({ contents: binarySource, loader: "js" }),
          );
        },
      },
    ],
  });
  const compressed = brotliCompressSync(
    Buffer.from(worker.outputFiles[0]!.text),
  );
  await mkdir(fromRoot("apps/server/dist/evaluations"), { recursive: true });
  await writeFile(
    fromRoot("apps/server/dist/evaluations/workbook-inspector-source.js"),
    `import {brotliDecompressSync} from "node:zlib"; export const workbookInspectorSource = brotliDecompressSync(Buffer.from(${JSON.stringify(compressed.toString("base64"))}, "base64")).toString("utf8");\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await buildWorkbookInspector();
