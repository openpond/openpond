import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bundleNode, fromRoot, makeExecutable } from "./shared-esbuild.js";

export type CliBundleSurface = "all" | "cli" | "package";

export async function bundleCli(surface: CliBundleSurface = "all"): Promise<void> {
  const entryPoints: Record<string, string> = {};
  if (surface === "all" || surface === "cli") entryPoints.cli = fromRoot("apps", "cli", "src", "cli", "main.ts");
  if (surface === "all" || surface === "package") {
    entryPoints["app-server"] = fromRoot("apps", "cli", "src", "app-server.ts");
    entryPoints.index = fromRoot("apps", "cli", "src", "index.ts");
    entryPoints["sandbox-template/manifest"] = fromRoot("apps", "cli", "src", "sandbox-template", "manifest.ts");
  }
  // One production graph shares interpreter payloads between CLI and package entrypoints.
  const result = await bundleNode({
    metafile: true,
    entryPoints,
    outdir: fromRoot("apps", "cli", "dist"),
    splitting: true,
    minify: true,
    keepNames: true,
    chunkNames: "chunks/[name]-[hash]",
    define: { __OPENPOND_COMPILED_CLI__: "false" },
    external: ["esbuild", "node-pty"],
  });
  if (surface === "all") {
    const outputs = Object.keys(result.metafile!.outputs)
      .map((file) => path.relative(fromRoot("apps", "cli"), path.resolve(file)).replaceAll("\\", "/"))
      .sort();
    await mkdir(fromRoot("apps", "cli", "build"), { recursive: true });
    await writeFile(fromRoot("apps", "cli", "build", "runtime-outputs.json"), JSON.stringify(outputs, null, 2) + "\n");
  }
  if (surface === "all" || surface === "cli") await makeExecutable(fromRoot("apps", "cli", "dist", "cli.js"));
}

function parseSurface(value: string | undefined): CliBundleSurface {
  if (!value) return "all";
  if (value === "all" || value === "cli" || value === "package") return value;
  throw new Error(`Unknown CLI bundle surface: ${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleCli(parseSurface(process.argv[2]));
}
