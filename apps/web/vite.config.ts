import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const openPondServerUrl = process.env.VITE_OPENPOND_SERVER_URL;
const openPondWebPort = Number.parseInt(process.env.OPENPOND_WEB_PORT ?? "17876", 10);

export default defineConfig({
  base: "./",
  plugins: [react()],
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
