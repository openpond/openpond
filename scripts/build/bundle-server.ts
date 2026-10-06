import { pathToFileURL } from "node:url";

import { bundleNode, fromRoot, makeExecutable } from "./shared-esbuild.js";
import {buildWorkbookInspector} from "./workbook-inspector.js";

export async function bundleServer(): Promise<void> {
  await buildWorkbookInspector();
  const outfile = fromRoot("apps", "server", "dist", "index.js");
  await bundleNode({
    entryPoints: [fromRoot("apps", "server", "src", "index.ts")],
    outfile,
    external: ["node-pty"],
    minify: true,
    keepNames: true,
  });
  await makeExecutable(outfile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleServer();
}
