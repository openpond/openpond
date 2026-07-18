import { app, BrowserWindow, Menu, dialog, ipcMain, shell, systemPreferences, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { isTrustedDesktopIpcFrameUrl } from "./desktop-ipc-trust.js";
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
import { showLoadError } from "./desktop-startup-page.js";
import { minimizeWindow } from "./desktop-window-controls.js";
import { DesktopBrowserControlWorker } from "./desktop-browser-control-worker.js";
import {
  bundledServerLaunchPort,
  canLaunchBundledDesktopServer,
  canReuseDesktopServer,
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
const browserControlExecutorToken = randomUUID();
const browserControlInstanceId = `desktop_${randomUUID()}`;
const localRequestTracker = new DesktopRequestTracker();
const serverProcessSampler = new DesktopProcessTreeSampler();
const backendManager = new DesktopBackendManager();

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
    const response = await fetch(`${url}/health`);
    if (!response.ok) return null;
    return (await response.json()) as DesktopServerHealth;
  } catch {
    return null;
  }
}

async function urlAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
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
    const timer = setTimeout(() => fail(new Error("OpenPond App server did not start in time")), 15000);
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
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function ensureServer(): Promise<ServerConnection> {
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
  desktopLogger().info("spawning server", { command, args, packaged: app.isPackaged });
  serverProcess = spawn(command, args, {
    cwd: serverWorkingDirectory(),
    env: {
      ...process.env,
      OPENPOND_APP_HOME: appHomePath(),
      OPENPOND_APP_CHANNEL: releaseChannel(),
      OPENPOND_APP_DOCUMENTS_DIR: app.getPath("documents"),
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

async function loadMainWindow(window: BrowserWindow): Promise<void> {
  try {
    const server = await ensureServer();
    if (!app.isPackaged) {
      trustedRendererUrl = await ensureRenderer();
      await window.loadURL(trustedRendererUrl);
    } else {
      trustedRendererUrl = rendererUrlForDesktop(server.serverUrl);
      await window.loadURL(trustedRendererUrl);
    }
    desktopLogger().info("main window loaded", { packaged: app.isPackaged });
    ensureBrowserControlWorker(server);
  } catch (error) {
    desktopLogger().error("main window load failed", { error });
    await showLoadError(window, error);
  }
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
  handleTrackedIpc("openpond:connection", () => ensureServer());
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
  handleTrackedIpc("openpond:window:close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) return false;
    window.close();
    return true;
  });
}

function handleTrackedIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, localRequestTracker.wrap(channel, (event, ...args) => {
    assertTrustedDesktopIpcEvent(event);
    return listener(event, ...args);
  }));
}

function assertTrustedDesktopIpcEvent(event: Electron.IpcMainInvokeEvent): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
    throw new Error("Untrusted IPC sender.");
  }
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Untrusted IPC frame.");
  }
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedDesktopIpcFrameUrl({
    frameUrl,
    packaged: app.isPackaged,
    trustedRendererUrl,
  })) {
    throw new Error("Untrusted IPC origin.");
  }
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    desktopLogger().error("renderer process gone", { details });
  });
  installEditContextMenu(mainWindow);

  await loadMainWindow(mainWindow);
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
          { role: "reload" },
          { role: "toggleDevTools" },
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

const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();
app.on("second-instance", () => showMainWindow());

app.whenReady().then(() => {
  if (!ownsSingleInstanceLock) return;
  configureApplicationMenu();
  app.dock?.setIcon(appIconPath());
  desktopLogger().info("desktop app ready", { packaged: app.isPackaged });
  void createWindow();
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
app.on("before-quit", (event) => {
  if (desktopShutdownComplete) return;
  event.preventDefault();
  if (desktopShutdownStarted) return;
  desktopShutdownStarted = true;
  desktopLogger().info("desktop app quitting");
  stopBrowserControlWorker();
  serverProcessSampler.stop();
  void Promise.all([closeBrowserSidebarManagers(), backendManager.close()])
    .catch((error) => desktopLogger().error("desktop backend shutdown failed", { error }))
    .finally(async () => {
      await desktopLogger().flush();
      desktopShutdownComplete = true;
      app.quit();
    });
});

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
