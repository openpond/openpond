import { pathToFileURL } from "node:url";

import { bundleNode, fromRoot } from "./shared-esbuild.js";

export async function bundleDesktop(): Promise<void> {
  await bundleNode({
    entryPoints: [fromRoot("apps", "desktop", "src", "main.ts")],
    outfile: fromRoot("apps", "desktop", "dist", "main.js"),
    external: ["electron"],
  });
  await bundleNode({
    entryPoints: [fromRoot("apps", "desktop", "src", "preload.ts")],
    outfile: fromRoot("apps", "desktop", "dist", "preload.js"),
    external: ["electron"],
    format: "cjs",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleDesktop();
}
