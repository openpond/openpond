import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const NODE_TARGET = "node24.18";

export async function bundleNode(options: BuildOptions): Promise<void> {
  const outputPath = options.outfile ?? options.outdir;
  if (outputPath) await mkdir(options.outfile ? path.dirname(outputPath) : outputPath, { recursive: true });
  const format = options.format ?? "esm";

  await build({
    bundle: true,
    platform: "node",
    target: NODE_TARGET,
    format,
    logLevel: "info",
    sourcemap: false,
    legalComments: "none",
    ...(format === "esm"
      ? {
          banner: {
            js: 'import { createRequire as __openpondCreateRequire } from "node:module"; var require = __openpondCreateRequire(import.meta.url);',
          },
        }
      : {}),
    ...options,
  });
}

export async function makeExecutable(filePath: string): Promise<void> {
  if (process.platform !== "win32") await chmod(filePath, 0o755);
}

export function fromRoot(...segments: string[]): string {
  return path.join(REPOSITORY_ROOT, ...segments);
}
