import { app, BrowserWindow, Menu, dialog, ipcMain, shell, systemPreferences, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appDisplayName,
  appHomePath,
  appIconPath,
  bunBinary,
  defaultServerPort,
  desktopDirname,
  desktopLogger,
  nodeBinary,
  releaseChannel,
  repoRoot,
  serverWorkingDirectory,
  tokenFilePath,
} from "./desktop-environment.js";
import { registerBrowserSidebarIpc } from "./desktop-browser-ipc.js";
import { createReadyLineParser } from "./child-process-ready.js";
import { DesktopProcessTreeSampler } from "./desktop-process-sampler.js";
import { DesktopRequestTracker } from "./desktop-request-tracker.js";
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

type ServerConnection = {
  serverUrl: string;
  token: string;
  platform: string;
  arch: string;
};

type ServerHealth = {
  ok: boolean;
  server?: string;
  version?: string;
  runtimeVersion?: string;
};

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcessWithoutNullStreams | null = null;
let webProcess: ChildProcessWithoutNullStreams | null = null;
let connection: ServerConnection | null = null;
let ipcHandlersRegistered = false;
let browserControlWorker: DesktopBrowserControlWorker | null = null;
const browserControlExecutorToken = randomUUID();
const browserControlInstanceId = `desktop_${randomUUID()}`;
const localRequestTracker = new DesktopRequestTracker();
const serverProcessSampler = new DesktopProcessTreeSampler();

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
  try {
    const token = (await fs.readFile(tokenFilePath(), "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

async function health(url: string): Promise<ServerHealth | null> {
  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) return null;
    return (await response.json()) as ServerHealth;
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
  if (connection) {
    if (await health(connection.serverUrl)) return connection;
    connection = null;
    serverProcess = null;
    stopBrowserControlWorker();
    serverProcessSampler.stop();
  }
  const serverPort = defaultServerPort();
  const existingUrl = process.env.OPENPOND_SERVER_URL || `http://127.0.0.1:${serverPort}`;
  const existingToken = await readToken();
  const existingHealth = existingToken ? await health(existingUrl) : null;
  const explicitServerUrl = Boolean(process.env.OPENPOND_SERVER_URL);
  const shouldReuseExistingServer =
    existingToken &&
    existingHealth?.ok &&
    (explicitServerUrl || app.isPackaged || process.env.OPENPOND_REUSE_SERVER === "1");
  if (shouldReuseExistingServer) {
    desktopLogger().info("reusing existing server", { serverUrl: existingUrl });
    serverProcessSampler.stop();
    connection = { serverUrl: existingUrl, token: existingToken, platform: process.platform, arch: process.arch };
    return connection;
  }

  const root = repoRoot();
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, "server", "index.js")
    : path.join(root, "apps", "server", "dist", "index.js");
  const command = app.isPackaged ? process.execPath : nodeBinary();
  const args = app.isPackaged
    ? [serverEntry, "web", "--port", String(serverPort)]
    : [serverEntry, "--port", String(existingHealth?.ok ? 0 : serverPort)];
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
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
  serverProcessSampler.start(serverProcess.pid);
  serverProcess.on("error", (error) => {
    serverProcessSampler.stop();
    desktopLogger().error("server process error", { error });
  });
  serverProcess.on("exit", (code, signal) => {
    desktopLogger().warn("server process exited", { code, signal });
    serverProcess = null;
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
  } catch (error) {
    serverProcessSampler.stop();
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

function rendererUrlForDesktop(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

async function ensureRenderer(server: ServerConnection): Promise<string> {
  const rendererUrl = process.env.OPENPOND_WEB_URL || defaultRendererDevUrl();
  if (await urlAvailable(rendererUrl)) return rendererUrlForDesktop(rendererUrl);

  if (!canStartLocalRenderer(rendererUrl)) {
    throw new Error(`Renderer URL is not available: ${rendererUrl}`);
  }

  if (!webProcess) {
    desktopLogger().info("spawning renderer dev server", { rendererUrl });
    webProcess = spawn(bunBinary(), ["run", "--cwd", "apps/web", "dev"], {
      cwd: repoRoot(),
      env: {
        ...process.env,
      },
    });
    webProcess.stdout.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      desktopLogger().debug("renderer stdout", { output });
      console.log(output);
    });
    webProcess.stderr.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      desktopLogger().warn("renderer stderr", { output });
      console.error(output);
    });
    webProcess.on("exit", (code, signal) => {
      desktopLogger().warn("renderer dev server exited", { code, signal });
      webProcess = null;
    });
  }

  await waitForUrl(rendererUrl);
  return rendererUrlForDesktop(rendererUrl);
}

async function loadMainWindow(window: BrowserWindow): Promise<void> {
  try {
    const server = await ensureServer();
    if (!app.isPackaged) {
      await window.loadURL(await ensureRenderer(server));
    } else {
      await window.loadFile(path.join(process.resourcesPath, "web", "index.html"));
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
  ipcMain.handle(channel, localRequestTracker.wrap(channel, listener));
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
      sandbox: false,
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

app.whenReady().then(() => {
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

app.on("before-quit", () => {
  desktopLogger().info("desktop app quitting");
  stopBrowserControlWorker();
  serverProcessSampler.stop();
  serverProcess?.kill("SIGTERM");
  webProcess?.kill("SIGTERM");
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
