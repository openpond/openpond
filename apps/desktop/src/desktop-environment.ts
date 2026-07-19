import { app } from "electron";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type Logger } from "@openpond/logging";

export const desktopDirname = path.dirname(fileURLToPath(import.meta.url));
let cachedReleaseChannel: ReleaseChannel | null = null;
let cachedLogger: Logger | null = null;

export type ReleaseChannel = "stable" | "nightly";

export function repoRoot(): string {
  return path.resolve(desktopDirname, "../../..");
}

export function serverWorkingDirectory(): string {
  return app.isPackaged ? process.resourcesPath : repoRoot();
}

export function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icons", "512x512.png")
    : path.join(repoRoot(), "apps", "desktop", "build", "icons", "512x512.png");
}

export function releaseChannel(): ReleaseChannel {
  if (process.env.OPENPOND_APP_CHANNEL === "nightly") return "nightly";
  if (cachedReleaseChannel) return cachedReleaseChannel;
  try {
    const raw = readFileSync(path.join(desktopDirname, "release-channel.json"), "utf8");
    const parsed = JSON.parse(raw) as { channel?: unknown };
    cachedReleaseChannel = parsed.channel === "nightly" ? "nightly" : "stable";
  } catch {
    cachedReleaseChannel = "stable";
  }
  return cachedReleaseChannel;
}

export function appDisplayName(): string {
  return releaseChannel() === "nightly" ? "openpond nightly" : "openpond";
}

app.setName(appDisplayName());
app.setAboutPanelOptions({
  applicationName: appDisplayName(),
  applicationVersion: app.getVersion(),
  iconPath: appIconPath(),
});

export function appHomePath(): string {
  if (process.env.OPENPOND_APP_HOME) return process.env.OPENPOND_APP_HOME;
  const dirname = releaseChannel() === "nightly" ? "openpond-app-nightly" : "openpond-app";
  return path.join(os.homedir(), ".openpond", dirname);
}

export function logDirPath(): string {
  return path.join(appHomePath(), "logs");
}

export function diagnosticsDirPath(): string {
  return path.join(appHomePath(), "diagnostics");
}

export function desktopLogger(): Logger {
  if (!cachedLogger) {
    cachedLogger = createLogger({
      channel: "desktop",
      logDir: logDirPath(),
      metadata: {
        releaseChannel: releaseChannel(),
        appVersion: app.getVersion(),
      },
    });
  }
  return cachedLogger;
}

export function defaultServerPort(): number {
  const explicitPort = Number.parseInt(process.env.OPENPOND_SERVER_PORT ?? "", 10);
  if (Number.isFinite(explicitPort)) return explicitPort;
  return releaseChannel() === "nightly" ? 17875 : 17874;
}

export function tokenFilePath(): string {
  return path.join(appHomePath(), "token");
}

export function pnpmBinary(): string {
  return process.env.PNPM_BINARY || "pnpm";
}
