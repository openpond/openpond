import { existsSync } from "node:fs";
import { saveImageDownload } from "./desktop-image-download.js";
import { prepareDesktopBrowserHome } from "./desktop-browser-home.js";
import { initializeDesktopExecutablePath } from "./desktop-executable-path.js";
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell, systemPreferences, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appDisplayName,
  appHomePath,
  appIconPath,
  defaultServerPort,
  desktopDirname,
  desktopLogger,
  pnpmBinary,
  releaseChannel,
  repoRoot,
  serverWorkingDirectory,
  tokenFilePath,
} from "./desktop-environment.js";
import { closeBrowserSidebarManagers, registerBrowserSidebarIpc } from "./desktop-browser-ipc.js";
import { createReadyLineParser } from "./child-process-ready.js";
import { DesktopBackendManager } from "./desktop-backend-manager.js";
import { createDesktopUpdater } from "./desktop-updater.js";
import type { DesktopUpdateController } from "./desktop-update-controller.js";
import { assertTrustedDesktopIpcEvent } from "./desktop-ipc-trust.js";
import {
  isAllowedExternalDesktopUrl,
  isTrustedDesktopNavigationUrl,
} from "./desktop-navigation-policy.js";
import { DesktopProcessTreeSampler } from "./desktop-process-sampler.js";
import { DesktopRequestTracker } from "./desktop-request-tracker.js";
import { readDesktopServerToken } from "./desktop-server-token.js";
import {
  copyRecentLogs,
  exportDiagnostics,
  lineLimitFromPayload,
  openLogsFolder,
  readRecentLogs,
} from "./desktop-diagnostics.js";
import { recoverDesktopHomeRuntime } from "./desktop-home-runtime.js";
import { singleFlightDesktopStartup } from "./desktop-server-startup.js";
import { DesktopWindowRecovery } from "./desktop-window-recovery.js";
import { showLoadError } from "./desktop-startup-page.js";
import { minimizeWindow } from "./desktop-window-controls.js";
import { DesktopBrowserControlWorker } from "./desktop-browser-control-worker.js";
import {
  bundledServerLaunchPort,
  canLaunchBundledDesktopServer,
  canReuseDesktopServer,
  desktopServerReadyTimeoutMs,
  isCompatibleDesktopServer,
  stopStaleLocalDesktopServer,
  type DesktopServerHealth,
} from "./desktop-server-compatibility.js";

type ServerConnection = {
  serverUrl: string;
  token: string;
  platform: string;
  arch: string;
};

type ClientDiagnosticPayload = {
  message: string;
  surface: string;
  stack?: string | null;
  context?: Record<string, unknown>;
};

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcessWithoutNullStreams | null = null;
let webProcess: ChildProcessWithoutNullStreams | null = null;
let connection: ServerConnection | null = null;
let ipcHandlersRegistered = false;
let browserControlWorker: DesktopBrowserControlWorker | null = null;
let trustedRendererUrl: string | null = null;
let startupPageUrl: string | null = null;
const browserControlExecutorToken = randomUUID();
const browserControlInstanceId = `desktop_${randomUUID()}`;
const localRequestTracker = new DesktopRequestTracker();
const serverProcessSampler = new DesktopProcessTreeSampler();
const backendManager = new DesktopBackendManager();
let desktopUpdater: DesktopUpdateController | null = null;

async function requestMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch (error) {
    desktopLogger().warn("microphone permission request failed", { error });
    return false;
  }
}

function defaultRendererDevUrl(): string {
  return `http://127.0.0.1:${process.env.OPENPOND_WEB_PORT || "17876"}`;
}

async function readToken(): Promise<string | null> {
  return readDesktopServerToken({
    environmentToken: process.env.OPENPOND_APP_TOKEN,
    tokenFile: tokenFilePath(),
  });
}

async function health(url: string): Promise<DesktopServerHealth | null> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return (await response.json()) as DesktopServerHealth;
  } catch {
    return null;
  }
}

async function urlAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function rendererDiagnosticPayload(payload: unknown): ClientDiagnosticPayload {
  const record = asRecord(payload);
  const nestedError = asRecord(record.error);
  const reason = record.reason;
  const reasonRecord = asRecord(reason);
  const message =
    stringValue(record.message) ??
    stringValue(nestedError.message) ??
    stringValue(reasonRecord.message) ??
    stringValue(reason) ??
    "Renderer error";
  return {
    message: message.slice(0, 4000),
    surface: "renderer",
    stack: (stringValue(nestedError.stack) ?? stringValue(reasonRecord.stack))?.slice(0, 12000) ?? null,
    context: {
      type: stringValue(record.type),
      filename: stringValue(record.filename),
      lineno: numberValue(record.lineno),
      colno: numberValue(record.colno),
      errorName: stringValue(nestedError.name) ?? stringValue(reasonRecord.name),
    },
  };
}

async function recordRendererDiagnostic(payload: unknown): Promise<boolean> {
  const activeConnection = connection;
  if (!activeConnection) return false;
  const response = await fetch(`${activeConnection.serverUrl}/v1/diagnostics/client`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${activeConnection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(rendererDiagnosticPayload(payload)),
  });
  return response.ok;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function waitForReady(child: ChildProcessWithoutNullStreams, fallbackUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      desktopLogger().info("server ready", { url });
      resolve(url);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const parser = createReadyLineParser<{ url?: string }>("OPENPOND_APP_SERVER_READY ", (payload) => {
      finish(payload.url || fallbackUrl);
    });
    const timer = setTimeout(
      () => fail(new Error("OpenPond App server did not start in time")),
      desktopServerReadyTimeoutMs(),
    );
    const onStdout = (chunk: Buffer) => {
      try {
        parser.push(chunk.toString("utf8"));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onStderr = (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      desktopLogger().warn("server stderr", { output });
      console.error(output);
    };
    const onExit = (code: number | null) => {
      parser.flush();
      fail(new Error(`OpenPond App server exited with code ${code ?? "unknown"}`));
    };
    const onError = (error: Error) => fail(error);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

const ensureServer = singleFlightDesktopStartup(startServer);

async function startServer(): Promise<ServerConnection> {
  await initializeDesktopExecutablePath(desktopLogger());
  const desktopVersion = app.getVersion();
  if (connection) {
    const connectionCompatible = isCompatibleDesktopServer(await health(connection.serverUrl), desktopVersion);
    const packagedRendererAvailable = !app.isPackaged || await urlAvailable(connection.serverUrl);
    if (connectionCompatible && packagedRendererAvailable) {
      return connection;
    }
    await backendManager.stopServer();
    connection = null;
    serverProcess = null;
    stopBrowserControlWorker();
    serverProcessSampler.stop();
  }
  const serverPort = defaultServerPort();
  const existingUrl = process.env.OPENPOND_SERVER_URL || `http://127.0.0.1:${serverPort}`;
  const explicitServerUrl = Boolean(process.env.OPENPOND_SERVER_URL);
  const existingToken = await readToken();
  if (app.isPackaged && !explicitServerUrl) {
    const existing = await recoverDesktopHomeRuntime({ home: appHomePath(), desktopVersion, token: existingToken,
      log: (message, context) => desktopLogger().info(message, context) });
    if (existing) {
      backendManager.useReusedServer();
      return connection = { ...existing, platform: process.platform, arch: process.arch };
    }
  }
  let existingHealth = app.isPackaged && !explicitServerUrl ? null : await health(existingUrl);
  if (explicitServerUrl && process.env.OPENPOND_REUSE_SERVER === "1" && !existingHealth?.ok) {
    existingHealth = await waitForServerHealth(existingUrl);
  }
  const existingServerCompatible = isCompatibleDesktopServer(existingHealth, desktopVersion);
  const existingRendererAvailable = !app.isPackaged || (existingServerCompatible && await urlAvailable(existingUrl));
  const shouldReuseExistingServer = canReuseDesktopServer({
    health: existingHealth,
    desktopVersion,
    token: existingToken,
    packaged: app.isPackaged,
    explicitServerUrl,
    reuseRequested: process.env.OPENPOND_REUSE_SERVER === "1",
    rendererAvailable: existingRendererAvailable,
  });
  if (shouldReuseExistingServer && existingToken) {
    desktopLogger().info("reusing existing server", { serverUrl: existingUrl });
    serverProcessSampler.stop();
    backendManager.useReusedServer();
    connection = { serverUrl: existingUrl, token: existingToken, platform: process.platform, arch: process.arch };
    return connection;
  }

  if (explicitServerUrl && existingHealth?.ok) {
    if (!existingServerCompatible) {
      throw new Error(
        `Configured OpenPond server version ${existingHealth.version ?? "unknown"} does not match Desktop ${desktopVersion}.`,
      );
    }
    if (app.isPackaged && existingServerCompatible && !existingRendererAvailable) {
      throw new Error(`Configured OpenPond server ${existingUrl} does not serve the packaged renderer.`);
    }
    throw new Error(`Configured OpenPond server ${existingUrl} does not have a capability token.`);
  }
  if (!canLaunchBundledDesktopServer(explicitServerUrl)) {
    throw new Error(`Configured OpenPond server is unavailable: ${existingUrl}`);
  }

  let launchPort = app.isPackaged ? 0 : serverPort;
  if (existingHealth?.ok) {
    const rendererMissing = app.isPackaged && existingServerCompatible && !existingRendererAvailable;
    const warning = rendererMissing
      ? "existing server does not serve packaged renderer"
      : "incompatible existing server";
    desktopLogger().warn(warning, {
      serverUrl: existingUrl,
      desktopVersion,
      serverVersion: existingHealth.version ?? null,
      serverName: existingHealth.server ?? null,
    });
    const retirement =
      !rendererMissing &&
      existingToken &&
      existingHealth.server === "openpond-app-server"
        ? await stopStaleLocalDesktopServer(existingUrl)
        : { stopped: false, processIds: [] };
    desktopLogger()[retirement.stopped ? "info" : "warn"]("stale server retirement", {
      serverUrl: existingUrl,
      stopped: retirement.stopped,
      processIds: retirement.processIds,
    });
    launchPort = bundledServerLaunchPort(
      serverPort,
      await health(existingUrl),
      retirement.stopped,
    );
  }

  const root = repoRoot();
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, "server", "index.js")
    : path.join(root, "apps", "server", "dist", "index.js");
  // Use Electron's pinned Node runtime for the bundled server in both dev and
  // packaged builds. Falling back to a shell `node` makes desktop behavior
  // depend on the caller's PATH and can silently launch an unsupported runtime.
  const command = process.execPath;
  const args = app.isPackaged
    ? [serverEntry, "web", "--port", String(launchPort)]
    : [serverEntry, "--port", String(launchPort)];
  if (browserHomeMigration?.sourceBrowserState) args.push("--source-browser-state", browserHomeMigration.sourceBrowserState);
  desktopLogger().info("spawning server", { command, args, packaged: app.isPackaged });
  serverProcess = spawn(command, args, {
    cwd: serverWorkingDirectory(),
    env: {
      ...process.env,
      OPENPOND_HOME: appHomePath(),
      OPENPOND_APP_CHANNEL: releaseChannel(),
      OPENPOND_APP_DOCUMENTS_DIR: app.getPath("documents"),
      OPENPOND_COLLECTOR_CLI: app.isPackaged ? path.join(process.resourcesPath, "cli", "cli.js") : path.join(root, "apps", "cli", "dist", "cli.js"),
      OPENPOND_COLLECTOR_EXECUTABLE: process.execPath,
      ...(app.isPackaged
        ? {}
        : {
            OPENPOND_REMOTE_ACCESS_TARGET:
              process.env.OPENPOND_WEB_URL || defaultRendererDevUrl(),
          }),
      ELECTRON_RUN_AS_NODE: "1",
    },
    detached: process.platform !== "win32",
  });
  const ownedServerProcess = serverProcess;
  backendManager.useOwnedServer(ownedServerProcess);
  serverProcessSampler.start(serverProcess.pid);
  serverProcess.on("error", (error) => {
    serverProcessSampler.stop();
    desktopLogger().error("server process error", { error });
  });
  ownedServerProcess.on("exit", (code, signal) => {
    desktopLogger().warn("server process exited", { code, signal });
    serverProcess = null;
    backendManager.releaseServer(ownedServerProcess);
    connection = null;
    stopBrowserControlWorker();
    serverProcessSampler.stop();
  });
  let serverUrl: string;
  let token: string | null;
  try {
    serverUrl = await waitForReady(serverProcess, existingUrl);
    token = await readToken();
    if (!token) throw new Error("OpenPond App server did not write a capability token");
    const launchedHealth = await health(serverUrl);
    if (!isCompatibleDesktopServer(launchedHealth, desktopVersion)) {
      throw new Error(
        `Bundled OpenPond server version ${launchedHealth?.version ?? "unknown"} does not match Desktop ${desktopVersion}.`,
      );
    }
  } catch (error) {
    serverProcessSampler.stop();
    await backendManager.stopServer();
    throw error;
  }
  connection = { serverUrl, token, platform: process.platform, arch: process.arch };
  return connection;
}

function canStartLocalRenderer(url: string): boolean {
  try {
    const parsed = new URL(url);
    const defaultRendererUrl = new URL(defaultRendererDevUrl());
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === defaultRendererUrl.port
    );
  } catch {
    return false;
  }
}

async function waitForUrl(url: string, timeoutMs = 20000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await urlAvailable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Renderer did not become available at ${url}`);
}

async function waitForServerHealth(url: string, timeoutMs = 15_000): Promise<DesktopServerHealth | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await health(url);
    if (current?.ok) return current;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

function rendererUrlForDesktop(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

async function ensureRenderer(): Promise<string> {
  const rendererUrl = process.env.OPENPOND_WEB_URL || defaultRendererDevUrl();
  if (await urlAvailable(rendererUrl)) return rendererUrlForDesktop(rendererUrl);

  if (!canStartLocalRenderer(rendererUrl)) {
    throw new Error(`Renderer URL is not available: ${rendererUrl}`);
  }

  if (!webProcess) {
    desktopLogger().info("spawning renderer dev server", { rendererUrl });
    webProcess = spawn(pnpmBinary(), ["--dir", "apps/web", "run", "dev"], {
      cwd: repoRoot(),
      env: {
        ...process.env,
      },
      detached: process.platform !== "win32",
    });
    const ownedWebProcess = webProcess;
    backendManager.useOwnedRenderer(ownedWebProcess);
    ownedWebProcess.stdout.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      desktopLogger().debug("renderer stdout", { output });
      console.log(output);
    });
    ownedWebProcess.stderr.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      desktopLogger().warn("renderer stderr", { output });
      console.error(output);
    });
    ownedWebProcess.on("exit", (code, signal) => {
      desktopLogger().warn("renderer dev server exited", { code, signal });
      webProcess = null;
      backendManager.releaseRenderer(ownedWebProcess);
    });
  }

  await waitForUrl(rendererUrl);
  return rendererUrlForDesktop(rendererUrl);
}

const windowRecoveries = new WeakMap<BrowserWindow, DesktopWindowRecovery>();

function loadMainWindow(window: BrowserWindow): Promise<void> {
  return windowRecoveries.get(window)!.retry();
}

async function loadWindowContent(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || desktopShutdownStarted) return;
  if (browserHomeError) throw browserHomeError;
  const server = await ensureServer();
  startupPageUrl = null;
  if ((await health(server.serverUrl))?.recovery) {
    const recoveryUrl = new URL(server.serverUrl);
    if (!app.isPackaged) recoveryUrl.hash = new URLSearchParams({ returnTo: await ensureRenderer() }).toString();
    trustedRendererUrl = recoveryUrl.toString();
    await window.loadURL(trustedRendererUrl);
    return;
  }
  if (!app.isPackaged) {
    trustedRendererUrl = await ensureRenderer();
    await window.loadURL(trustedRendererUrl);
  } else {
    trustedRendererUrl = rendererUrlForDesktop(server.serverUrl);
    await window.loadURL(trustedRendererUrl);
  }
  desktopLogger().info("main window loaded", { packaged: app.isPackaged });
  ensureBrowserControlWorker(server);
}

function ensureBrowserControlWorker(server: ServerConnection): void {
  const next = {
    serverUrl: server.serverUrl,
    token: server.token,
    executorToken: browserControlExecutorToken,
  };
  if (browserControlWorker?.matches(next)) return;
  stopBrowserControlWorker();
  browserControlWorker = new DesktopBrowserControlWorker({
    ...next,
    instanceId: browserControlInstanceId,
    getWindow: () => mainWindow,
    logger: desktopLogger(),
  });
  browserControlWorker.start();
}

function stopBrowserControlWorker(): void {
  browserControlWorker?.stop();
  browserControlWorker = null;
}

function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;
  registerBrowserSidebarIpc(() => mainWindow, handleTrackedIpc);
  handleTrackedIpc("openpond:updates:state", () => desktopUpdater!.getState());
  handleTrackedIpc("openpond:updates:check", () => desktopUpdater!.check());
  handleTrackedIpc("openpond:updates:download", () => desktopUpdater!.download());
  handleTrackedIpc("openpond:updates:restart", (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        typeof (payload as Record<string, unknown>).hasRunningWork !== "boolean") {
      throw new Error("Invalid update restart request.");
    }
    return desktopUpdater!.restart((payload as { hasRunningWork: boolean }).hasRunningWork);
  });
  handleTrackedIpc("openpond:connection", () => ensureServer());
  handleTrackedIpc("openpond:desktop:runtimeInfo", () => {
    const devMode =
      !app.isPackaged && process.env.OPENPOND_DESKTOP_DEV_MODE === "1";
    return {
      version: app.getVersion(),
      releaseChannel: releaseChannel(),
      packaged: app.isPackaged,
      devMode,
      canReload: devMode,
    };
  });
  handleTrackedIpc("openpond:desktop:reload", (event) => {
    if (app.isPackaged || process.env.OPENPOND_DESKTOP_DEV_MODE !== "1") {
      return {
        ok: false,
        error: "App refresh is only available when OpenPond is running through pnpm dev.",
      };
    }
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window || window.isDestroyed()) {
      return { ok: false, error: "No app window is available." };
    }
    setTimeout(() => {
      if (!window.isDestroyed()) void loadMainWindow(window);
    }, 50);
    return { ok: true };
  });
  handleTrackedIpc("openpond:desktop:restart", () => {
    void restartDesktopApp();
    return { ok: true };
  });
  handleTrackedIpc("openpond:startup:retry", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) return { ok: false, error: "No app window is available." };
    await loadMainWindow(window);
    return { ok: true };
  });
  handleTrackedIpc("openpond:logs:open", () => openLogsFolder());
  handleTrackedIpc("openpond:logs:readRecent", (_event, payload) => readRecentLogs(lineLimitFromPayload(payload)));
  handleTrackedIpc("openpond:logs:copyRecent", (_event, payload) => copyRecentLogs(lineLimitFromPayload(payload)));
  handleTrackedIpc("openpond:diagnostics:export", () =>
    exportDiagnostics({
      serverConnection: () => connection,
      requests: () => ({
        localRpc: localRequestTracker.snapshot({
          excludeChannels: ["openpond:diagnostics:export"],
        }),
      }),
      resources: () => ({
        serverProcess: serverProcessSampler.snapshot(),
      }),
    }),
  );
  handleTrackedIpc("openpond:folder:select", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options = {
      title: "Add project folder",
      properties: ["openDirectory"],
    } satisfies Electron.OpenDialogOptions;
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] };
  });
  handleTrackedIpc("openpond:taskset-package:select", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options = {
      title: "Import Taskset package",
      properties: ["openDirectory"],
    } satisfies Electron.OpenDialogOptions;
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] };
  });
  handleTrackedIpc("openpond:file:reveal", async (_event, payload) => {
    const rawPath = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).path
      : null;
    const expandedPath = typeof rawPath === "string" && rawPath.startsWith("~/")
      ? path.join(app.getPath("home"), rawPath.slice(2)) : rawPath;
    if (typeof expandedPath !== "string" || !path.isAbsolute(expandedPath)) {
      return { ok: false, error: "An absolute local file path is required." };
    }
    try {
      const target = path.resolve(expandedPath);
      if ((await fs.stat(target)).isDirectory()) {
        const error = await shell.openPath(target);
        return { ok: !error, ...(error ? { error } : {}) };
      }
      shell.showItemInFolder(target);
      return { ok: true };
    } catch {
      return { ok: false, error: "The local path could not be opened." };
    }
  });
  handleTrackedIpc("openpond:file:saveAs", async (event, payload) => {
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const rawPath = record.path;
    const suggestedName = record.suggestedName;
    if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) {
      return { ok: false, canceled: false, error: "An absolute local file path is required." };
    }
    const sourcePath = path.resolve(rawPath);
    const defaultPath =
      typeof suggestedName === "string" && suggestedName.trim()
        ? path.basename(suggestedName.trim())
        : path.basename(sourcePath);
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options = {
      title: "Save Work output",
      defaultPath,
    } satisfies Electron.SaveDialogOptions;
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, path: null };
    }
    await fs.copyFile(sourcePath, result.filePath);
    return { ok: true, canceled: false, path: result.filePath };
  });
  handleTrackedIpc("openpond:file:saveImage", (event, payload) =>
    saveImageDownload(event.sender, payload, app.getPath("downloads")));
  handleTrackedIpc("openpond:microphone:request", () => requestMicrophoneAccess());
  handleTrackedIpc("openpond:renderer:error", (_event, payload) => {
    desktopLogger().error("renderer error", { payload });
    void recordRendererDiagnostic(payload).catch((error) => {
      desktopLogger().warn("renderer diagnostic forward failed", { error });
    });
    return true;
  });
  handleTrackedIpc("openpond:window:minimize", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) return false;
    return minimizeWindow(window);
  });
  handleTrackedIpc("openpond:window:toggleMaximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return true;
  });
  const notificationIds = new Set<string>();
  handleTrackedIpc("openpond:notification", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid notification.");
    const payload = raw as Record<string, unknown>;
    if (typeof payload.id !== "string" || payload.id.length > 300 || typeof payload.title !== "string" || payload.title.length > 160 || typeof payload.body !== "string" || payload.body.length > 500) throw new Error("Invalid notification.");
    if (!Notification.isSupported() || notificationIds.has(payload.id)) return false;
    notificationIds.add(payload.id);
    if (notificationIds.size > 1000) notificationIds.delete(notificationIds.values().next().value!);
    const notification = new Notification({ title: payload.title, body: payload.body });
    notification.on("click", () => {
      showMainWindow();
      if (payload.ponder === true) mainWindow?.webContents.send("openpond:ponder-notification", { id: payload.id });
    }); notification.show();
    return true;
  });
  handleTrackedIpc("openpond:window:close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) return false;
    window.close();
    return true;
  });
}

function handleTrackedIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, localRequestTracker.wrap(channel, (event, ...args) => {
    assertTrustedDesktopIpcEvent(event, { window: mainWindow, packaged: app.isPackaged, trustedRendererUrl, startupPageUrl, channel });
    return listener(event, ...args);
  }));
}

function installMediaPermissionHandlers(window: BrowserWindow): void {
  const appSession = window.webContents.session;
  appSession.setPermissionCheckHandler((contents, permission) => {
    if (permission !== "media" || !contents || contents.id !== window.webContents.id) return false;
    if (process.platform === "darwin") {
      return systemPreferences.getMediaAccessStatus("microphone") === "granted";
    }
    return true;
  });
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== "media" || !contents || contents.id !== window.webContents.id) {
      callback(false);
      return;
    }
    const rawMediaTypes = (details as { mediaTypes?: unknown }).mediaTypes;
    const mediaTypes = new Set(Array.isArray(rawMediaTypes) ? rawMediaTypes : []);
    if (mediaTypes.has("video") || (mediaTypes.size > 0 && !mediaTypes.has("audio"))) {
      callback(false);
      return;
    }
    void requestMicrophoneAccess().then(callback);
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function installEditContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: "copy" });
    }

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}

function openExternalDesktopUrl(url: string): void {
  const protocol = (() => {
    try {
      return new URL(url).protocol;
    } catch {
      return "invalid";
    }
  })();
  if (!isAllowedExternalDesktopUrl(url)) {
    desktopLogger().warn("blocked unsafe external URL", { protocol });
    return;
  }
  void shell.openExternal(url).catch((error) => {
    desktopLogger().warn("external URL failed to open", { protocol, error });
  });
}

function installNavigationHandlers(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalDesktopUrl(url);
    return { action: "deny" };
  });
  const protectMainFrameNavigation = (event: Electron.Event, url: string) => {
    if (isTrustedDesktopNavigationUrl({
      navigationUrl: url,
      packaged: app.isPackaged,
      trustedRendererUrl,
    })) return;
    event.preventDefault();
    openExternalDesktopUrl(url);
  };
  window.webContents.on("will-navigate", protectMainFrameNavigation);
  window.webContents.on("will-redirect", protectMainFrameNavigation);
}

async function createWindow(): Promise<void> {
  registerIpcHandlers();
  const preloadPath = path.join(desktopDirname, "preload.js");
  desktopLogger().info("creating main window", { preloadPath });

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#141414",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 15 },
        }
      : { frame: false }),
    icon: appIconPath(),
    title: appDisplayName(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    stopBrowserControlWorker();
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPathValue, error) => {
    desktopLogger().error("preload failed", { preloadPath: preloadPathValue, error });
  });
  mainWindow.setMenuBarVisibility(false);
  installMediaPermissionHandlers(mainWindow);

  installNavigationHandlers(mainWindow);
  const window = mainWindow;
  const recovery = new DesktopWindowRecovery(
    () => loadWindowContent(window),
    async (error) => {
      if (window.isDestroyed() || desktopShutdownStarted) return;
      desktopLogger().error("main window recovery failed", { error });
      await showLoadError(window, error, (url) => { startupPageUrl = url; });
    },
  );
  windowRecoveries.set(window, recovery);
  const failed = (error: Error) => {
    if (desktopShutdownStarted || window.isDestroyed()) return;
    void recovery.failed(error).catch((error) => desktopLogger().error("recovery page failed", { error }));
  };
  window.webContents.on("render-process-gone", (_event, details) => {
    desktopLogger().error("renderer process gone", { details });
    if (details.reason !== "clean-exit") failed(new Error(`App renderer stopped: ${details.reason}`));
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !url.startsWith("data:")) failed(new Error(`App failed to load: ${description}`));
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "r") {
      event.preventDefault();
      void loadMainWindow(window);
    } else if (process.platform !== "darwin" && input.key === "Alt") {
      event.preventDefault();
      Menu.buildFromTemplate(recoveryMenuItems()).popup({ window });
    }
  });
  installEditContextMenu(mainWindow);

  await loadMainWindow(mainWindow);
}

let restartingDesktop = false;
async function restartDesktopApp(): Promise<void> {
  if (restartingDesktop || desktopShutdownStarted) return;
  restartingDesktop = true;
  try {
    await shutdownDesktop();
    if (process.env.OPENPOND_DESKTOP_DEV_SUPERVISED === "1") app.exit(75);
    else {
      app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {});
      app.quit();
    }
  } catch (error) {
    desktopLogger().error("desktop restart failed", { error });
    app.exit(1);
  }
}

function recoveryMenuItems(): MenuItemConstructorOptions[] {
  return [
    { label: "Retry App", accelerator: "CommandOrControl+Shift+R", click: () => { if (mainWindow) void loadMainWindow(mainWindow); } },
    { label: "Restart App", click: () => { void restartDesktopApp(); } },
    { label: "Open Logs", click: () => { void openLogsFolder(); } },
    { role: "toggleDevTools" },
  ];
}

function configureApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: appDisplayName(),
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          ...recoveryMenuItems(),
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
      },
    ])
  );
}

const explicitBrowserUserData = process.env.OPENPOND_DESKTOP_USER_DATA_DIR?.trim() || app.commandLine.getSwitchValue("user-data-dir").trim();
const previousBrowserUserData = explicitBrowserUserData
  ? path.resolve(explicitBrowserUserData)
  : !app.isPackaged ? path.join(app.getPath("appData"), "openpond-dev") : app.getPath("userData");
let browserHomeMigration: ReturnType<typeof prepareDesktopBrowserHome> | null = null;
let browserHomeError: unknown = null;
const needsBrowserMigration = !existsSync(path.join(appHomePath(), "browser", "chromium")) && existsSync(previousBrowserUserData);
if (needsBrowserMigration) app.setPath("userData", previousBrowserUserData);
const ownsPreviousBrowserLock = !needsBrowserMigration || app.requestSingleInstanceLock();
if (ownsPreviousBrowserLock) {
  try { browserHomeMigration = prepareDesktopBrowserHome(appHomePath(), previousBrowserUserData); }
  catch (error) { browserHomeError = error; }
  if (needsBrowserMigration) app.releaseSingleInstanceLock();
  if (browserHomeMigration) app.setPath("userData", browserHomeMigration.userData);
}
const ownsSingleInstanceLock = ownsPreviousBrowserLock && app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();
app.on("second-instance", () => showMainWindow());

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  await initializeDesktopExecutablePath(desktopLogger());
  configureApplicationMenu();
  app.dock?.setIcon(appIconPath());
  desktopLogger().info("desktop app ready", { packaged: app.isPackaged });
  desktopUpdater = await createDesktopUpdater({
    publish: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("openpond:updates:state", state);
    },
    shutdown: shutdownDesktop,
    recoverAfterShutdown: async (error) => {
      desktopLogger().error("update restart failed after shutdown", { error });
      await dialog.showMessageBox({
        type: "error", title: "Update could not be installed",
        message: "OpenPond could not finish the update and will reopen. You can try again or install the latest release manually.",
      });
      app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {});
      desktopShutdownComplete = true;
      app.quit();
    },
  });
  void createWindow();
  desktopUpdater.start();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  else showMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let desktopShutdownStarted = false;
let desktopShutdownComplete = false;
let desktopShutdownPromise: Promise<void> | null = null;

function shutdownDesktop(): Promise<void> {
  if (desktopShutdownPromise) return desktopShutdownPromise;
  desktopShutdownStarted = true;
  desktopShutdownPromise = (async () => {
    desktopLogger().info("desktop app shutting down");
    stopBrowserControlWorker();
    serverProcessSampler.stop();
    const results = await Promise.allSettled([closeBrowserSidebarManagers(), backendManager.close()]);
    await desktopLogger().flush();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    desktopShutdownComplete = true;
  })();
  return desktopShutdownPromise;
}

app.on("before-quit", (event) => {
  if (desktopShutdownComplete) return;
  event.preventDefault();
  if (desktopShutdownStarted || desktopUpdater?.getState().status === "restarting") return;
  void shutdownDesktop()
    .catch((error) => desktopLogger().error("desktop backend shutdown failed", { error }))
    .finally(async () => {
      await desktopLogger().flush();
      desktopShutdownComplete = true;
      app.quit();
    });
});

app.on("will-quit", () => desktopUpdater?.stop());

process.on("uncaughtException", (error) => {
  desktopLogger().error("uncaught exception", { error });
  console.error(error);
  void desktopLogger()
    .flush()
    .finally(() => app.exit(1));
});

process.on("unhandledRejection", (reason) => {
  desktopLogger().error("unhandled rejection", { reason });
});
