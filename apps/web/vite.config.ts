import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import publicVideoManifest from "./src/lib/public-video-manifest.json";

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
      for (const video of publicVideoManifest.videos) {
        rmSync(resolve(outputRoot, video.localPath), { force: true });
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
