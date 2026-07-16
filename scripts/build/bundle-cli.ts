import { pathToFileURL } from "node:url";

import { bundleNode, fromRoot, makeExecutable } from "./shared-esbuild.js";

export type CliBundleSurface = "all" | "cli" | "package";

export async function bundleCli(surface: CliBundleSurface = "all"): Promise<void> {
  if (surface === "all" || surface === "cli") {
    const cliOutput = fromRoot("apps", "cli", "dist", "cli.js");
    await bundleNode({
      entryPoints: [fromRoot("apps", "cli", "src", "cli", "main.ts")],
      outdir: fromRoot("apps", "cli", "dist"),
      splitting: true,
      entryNames: "cli",
      chunkNames: "chunks/[name]-[hash]",
      define: { __OPENPOND_COMPILED_CLI__: "false" },
      external: ["node-pty"],
    });
    await makeExecutable(cliOutput);
  }

  if (surface === "all" || surface === "package") {
    await bundleNode({
      entryPoints: {
        index: fromRoot("apps", "cli", "src", "index.ts"),
        "sandbox-template/manifest": fromRoot(
          "apps",
          "cli",
          "src",
          "sandbox-template",
          "manifest.ts",
        ),
      },
      outdir: fromRoot("apps", "cli", "dist"),
      external: ["node-pty"],
    });
  }
}

function parseSurface(value: string | undefined): CliBundleSurface {
  if (!value || value === "all" || value === "cli" || value === "package") return value ?? "all";
  throw new Error(`Unknown CLI bundle surface: ${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleCli(parseSurface(process.argv[2]));
}
