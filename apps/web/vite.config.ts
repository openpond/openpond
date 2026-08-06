import { globSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const openPondServerUrl = process.env.VITE_OPENPOND_SERVER_URL;
const openPondWebPort = Number.parseInt(process.env.OPENPOND_WEB_PORT ?? "17876", 10);

function excludeLocalVideosFromProduction(): Plugin {
  let outputRoot = "";
  return {
    name: "exclude-local-public-videos",
    apply: "build",
    configResolved(config) {
      outputRoot = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      // Local development may have downloaded public videos that are ignored
      // by Git. Production and CLI distributions resolve video URLs through
      // the content-addressed public manifest, so no local MP4 belongs in a
      // deterministic package even when it is not yet listed in that manifest.
      for (const relativePath of globSync("**/*.mp4", { cwd: outputRoot })) {
        rmSync(resolve(outputRoot, relativePath), { force: true });
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), excludeLocalVideosFromProduction()],
  server: {
    host: "127.0.0.1",
    port: Number.isFinite(openPondWebPort) ? openPondWebPort : 17876,
    strictPort: true,
    proxy: openPondServerUrl
      ? {
          "/health": {
            target: openPondServerUrl,
            changeOrigin: true,
          },
          "/v1": {
            target: openPondServerUrl,
            changeOrigin: true,
            ws: true,
          },
        }
      : undefined,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
