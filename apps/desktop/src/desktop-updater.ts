import { app, autoUpdater as nativeUpdater, dialog } from "electron";
import electronUpdater, { type AppUpdater } from "electron-updater";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  desktopUpdateFeedChannel,
  type DesktopUpdateInstallKind,
  type DesktopUpdateState,
} from "@openpond/contracts/desktop-updates";
import { DesktopUpdateController, DesktopUpdateError, type DesktopUpdateDriver } from "./desktop-update-controller.js";
import { findDesktopUpdateRelease, type DesktopUpdateTarget, validateDesktopUpdateManifest } from "./desktop-update-release.js";
import { installDebUpdate, installPreparedAppImage, prepareAppImageUpdate, verifyDownloadedFile } from "./desktop-update-install.js";
import { desktopLogger, releaseChannel } from "./desktop-environment.js";

type RuntimeOptions = {
  publish: (state: DesktopUpdateState) => void;
  shutdown: () => Promise<void>;
  recoverAfterShutdown: (error: unknown) => Promise<void>;
};

export async function createDesktopUpdater(options: RuntimeOptions): Promise<DesktopUpdateController> {
  const channel = releaseChannel();
  const installKind = await detectInstallKind();
  const supported = installKind !== "unsupported";
  const target: DesktopUpdateTarget = {
    channel, installedVersion: app.getVersion(),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64",
  };
  return new DesktopUpdateController({
    ...options, installedVersion: target.installedVersion, channel, installKind,
    driver: supported ? createDriver(installKind, target) : null,
    confirmRestart: async (hasRunningWork) => {
      if (!hasRunningWork) return true;
      const result = await dialog.showMessageBox({
        type: "question", title: "Restart to update", message: "Restart OpenPond to update?",
        detail: "Running local tasks and open terminals will stop. You can finish your work and restart later.",
        buttons: ["Later", "Restart now"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1;
    },
    logError: (operation, error) => desktopLogger().warn("desktop update failed", { operation, error }),
  });
}

async function detectInstallKind(): Promise<DesktopUpdateInstallKind> {
  if (!app.isPackaged || !["x64", "arm64"].includes(process.arch)) return "unsupported";
  if (process.platform === "darwin") return "mac";
  if (process.platform !== "linux") return "unsupported";
  if (process.env.APPIMAGE && path.isAbsolute(process.env.APPIMAGE)) return "appimage";
  const packageType = await fs.readFile(path.join(process.resourcesPath, "package-type"), "utf8").catch(() => "");
  return packageType.trim() === "deb" ? "deb" : "unsupported";
}

function createDriver(installKind: Exclude<DesktopUpdateInstallKind, "unsupported">, target: DesktopUpdateTarget): DesktopUpdateDriver {
  const { MacUpdater, AppImageUpdater, DebUpdater } = electronUpdater;
  const updater: AppUpdater = installKind === "mac" ? new MacUpdater()
    : installKind === "deb" ? new DebUpdater() : new AppImageUpdater();
  updater.autoDownload = false;
  // Mac must stage and validate through Squirrel before the UI reports ready.
  // Staging never forces a restart, but a subsequent ordinary quit can apply it.
  updater.autoInstallOnAppQuit = installKind === "mac";
  updater.autoRunAppAfterInstall = true;
  updater.channel = desktopUpdateFeedChannel(target.channel, target.arch);
  updater.allowPrerelease = target.channel === "nightly";
  updater.allowDowngrade = false;
  updater.logger = {
    info: (...detail: unknown[]) => desktopLogger().info("desktop updater", { detail }),
    warn: (...detail: unknown[]) => desktopLogger().warn("desktop updater", { detail }),
    error: (...detail: unknown[]) => desktopLogger().error("desktop updater", { detail }),
  };
  const logError = (error: Error) => desktopLogger().warn("native desktop updater error", { error });
  updater.on("error", logError);
  let downloadedFile: string | null = null;
  let downloadHash: string | null = null;
  let selectedVersion: string | null = null;
  let stagedAppImage: string | null = null;
  let appImageDestination: string | null = null;
  let currentCheck: AbortController | null = null;
  let cancellationToken: { cancel(): void } | null = null;

  return {
    async check() {
      selectedVersion = null;
      downloadHash = null;
      currentCheck = new AbortController();
      const timer = setTimeout(() => currentCheck?.abort(), 20_000);
      try {
        const release = await findDesktopUpdateRelease(target, currentCheck.signal);
        if (!release) { selectedVersion = null; return null; }
        updater.setFeedURL({ provider: "generic", url: release.feedUrl, useMultipleRangeRequest: false });
        const result = await updater.checkForUpdates();
        if (!result?.isUpdateAvailable) { selectedVersion = null; return null; }
        const file = validateDesktopUpdateManifest(result.updateInfo, target, installKind, release.version);
        downloadHash = file.sha512;
        selectedVersion = release.version;
        cancellationToken = result.cancellationToken ?? null;
        return selectedVersion;
      } finally {
        clearTimeout(timer);
        currentCheck = null;
      }
    },
    async download(onProgress) {
      downloadedFile = null;
      const onDownloaded = (event: { downloadedFile: string }) => { downloadedFile = event.downloadedFile; };
      const onDownloadProgress = (event: { percent: number }) => onProgress(event.percent);
      updater.on("update-downloaded", onDownloaded);
      updater.on("download-progress", onDownloadProgress);
      const stage = installKind === "mac" ? waitForMacStage() : null;
      try {
        await Promise.all([
          updater.downloadUpdate().then(() => stage?.startTimeout()),
          stage?.promise,
        ]);
        if (!downloadedFile) throw new Error("Updater did not return a verified downloaded file.");
        if (installKind !== "mac") await verifyDownloadedFile(downloadedFile, downloadHash!);
      } catch (error) {
        if (error instanceof DesktopUpdateError && error.retry === "download" && downloadedFile) {
          await fs.rm(downloadedFile, { force: true });
        }
        throw error;
      } finally {
        stage?.dispose();
        updater.off("update-downloaded", onDownloaded);
        updater.off("download-progress", onDownloadProgress);
      }
    },
    async prepareInstall() {
      if (!downloadedFile || !downloadHash || !selectedVersion) throw new Error("No downloaded update is ready.");
      try {
        if (installKind === "deb") {
          await installDebUpdate({
            file: downloadedFile, sha512: downloadHash, version: selectedVersion, arch: target.arch,
            packageName: target.channel === "nightly" ? "openpond-nightly" : "openpond",
          });
        } else if (installKind === "appimage") {
          appImageDestination = await fs.realpath(process.env.APPIMAGE!);
          stagedAppImage = await prepareAppImageUpdate(downloadedFile, appImageDestination, downloadHash);
        }
      } catch (error) {
        if (error instanceof DesktopUpdateError && error.retry === "download") await fs.rm(downloadedFile, { force: true });
        throw error;
      }
    },
    install() {
      if (installKind === "mac") {
        updater.quitAndInstall();
      } else {
        if (installKind === "appimage") {
          if (!stagedAppImage || !appImageDestination) throw new Error("The AppImage was not prepared.");
          installPreparedAppImage(stagedAppImage, appImageDestination);
          stagedAppImage = null;
        }
        app.relaunch(installKind === "appimage" ? { execPath: appImageDestination! } : {});
        app.quit();
      }
    },
    dispose() {
      currentCheck?.abort();
      cancellationToken?.cancel();
      updater.off("error", logError);
      if (stagedAppImage) void fs.rm(stagedAppImage, { force: true }).catch(() => undefined);
    },
  };
}

function waitForMacStage(): { promise: Promise<void>; startTimeout: () => void; dispose: () => void } {
  let cleanup = () => {};
  let startTimeout = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    startTimeout = () => {
      if (!finished) timer = setTimeout(() => fail(new DesktopUpdateError("macOS could not finish verifying the update. Download it again and try again.")), 120_000);
    };
    cleanup = () => {
      finished = true;
      if (timer) clearTimeout(timer);
      nativeUpdater.off("update-downloaded", finish);
      nativeUpdater.off("error", fail);
    };
    nativeUpdater.once("update-downloaded", finish);
    nativeUpdater.once("error", fail);
  });
  return { promise, startTimeout: () => startTimeout(), dispose: () => cleanup() };
}
