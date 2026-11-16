import { pathToFileURL } from "node:url";

import { bundleNode, fromRoot } from "./shared-esbuild.js";
import { desktopAnalyticsConfig } from "../../apps/desktop/src/desktop-analytics-config.js";

export async function bundleDesktop(): Promise<void> {
  const analytics = desktopAnalyticsConfig(process.env, true);
  if (process.env.OPENPOND_POSTHOG_TOKEN && !analytics && process.env.OPENPOND_ANALYTICS_ENABLED !== "0") {
    throw new Error("Desktop analytics requires a public project token and valid HTTPS ingestion host.");
  }
  await bundleNode({
    entryPoints: [fromRoot("apps", "desktop", "src", "main.ts")],
    outfile: fromRoot("apps", "desktop", "dist", "main.js"),
    external: ["electron"],
    define: {
      __OPENPOND_DESKTOP_ANALYTICS__: JSON.stringify(analytics),
    },
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
