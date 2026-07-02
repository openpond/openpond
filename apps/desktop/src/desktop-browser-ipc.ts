import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { BrowserSidebarStore } from "./desktop-browser-store.js";
import { BrowserSidebarManager } from "./desktop-browser-sidebar.js";
import {
  isTrustedBrowserIpcFrameUrl,
  parseBrowserBoundsInput,
  parseBrowserConversationInput,
  parseBrowserNavigateInput,
  parseBrowserNewTabInput,
  parseBrowserOpenExternalInput,
  parseBrowserTabInput,
  parseBrowserUrlInput,
} from "./desktop-browser-ipc-validation.js";
import type {
  BrowserCommandResult,
} from "./desktop-browser-types.js";

const managers = new WeakMap<BrowserWindow, BrowserSidebarManager>();
let ipcRegistered = false;

export type DesktopIpcRegistrar = typeof ipcMain.handle;

export function registerBrowserSidebarIpc(
  getWindow: () => BrowserWindow | null,
  handleIpc: DesktopIpcRegistrar = ipcMain.handle.bind(ipcMain),
): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  handleIpc("openpond:browser:open", (event, input) => command(event, getWindow, (manager) => manager.open(parseBrowserUrlInput(input))));
  handleIpc("openpond:browser:newTab", (event, input) => command(event, getWindow, (manager) => manager.newTab(parseBrowserNewTabInput(input))));
  handleIpc("openpond:browser:selectTab", (event, input) => command(event, getWindow, (manager) => manager.selectTab(parseBrowserTabInput(input))));
  handleIpc("openpond:browser:closeTab", (event, input) => command(event, getWindow, (manager) => manager.closeTab(parseBrowserTabInput(input))));
  handleIpc("openpond:browser:navigate", (event, input) => command(event, getWindow, (manager) => manager.navigate(parseBrowserNavigateInput(input))));
  handleIpc("openpond:browser:back", (event, input) => command(event, getWindow, (manager) => manager.back(parseBrowserTabInput(input))));
  handleIpc("openpond:browser:forward", (event, input) => command(event, getWindow, (manager) => manager.forward(parseBrowserTabInput(input))));
  handleIpc("openpond:browser:reload", (event, input) => command(event, getWindow, (manager) => manager.reload(parseBrowserTabInput(input))));
  handleIpc("openpond:browser:stop", (event, input) => command(event, getWindow, (manager) => manager.stop(parseBrowserTabInput(input))));
  handleIpc("openpond:browser:close", (event, input) => command(event, getWindow, (manager) => manager.close(parseBrowserConversationInput(input))));
  handleIpc("openpond:browser:clearData", (event, input) => command(event, getWindow, (manager) => manager.clearData(parseBrowserConversationInput(input))));
  handleIpc("openpond:browser:openExternal", (event, input) => command(event, getWindow, (manager) => manager.openExternal(parseBrowserOpenExternalInput(input))));
  handleIpc("openpond:browser:setBounds", (event, input) => command(event, getWindow, (manager) => manager.setBounds(parseBrowserBoundsInput(input))));
  handleIpc("openpond:browser:getState", (event, input) =>
    browserManager(event, getWindow).state(parseBrowserConversationInput(input).conversationId),
  );
  handleIpc("openpond:browser:diagnostics", (event) => browserManager(event, getWindow).diagnostics());
}

async function command(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  fn: (manager: BrowserSidebarManager) => Promise<void>,
): Promise<BrowserCommandResult> {
  try {
    await fn(browserManager(event, getWindow));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function browserManager(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | null): BrowserSidebarManager {
  const window = trustedSenderWindow(event, getWindow);
  return managerFor(window);
}

function trustedSenderWindow(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | null): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  const expected = getWindow();
  if (!window) throw new Error("No app window is available.");
  if (!expected || expected.id !== window.id || event.sender.id !== window.webContents.id) {
    throw new Error("Untrusted IPC sender.");
  }
  const frameUrl = event.senderFrame?.url ?? "";
  if (frameUrl && !isTrustedBrowserIpcFrameUrl(frameUrl)) throw new Error("Untrusted IPC frame.");
  return window;
}

function managerFor(window: BrowserWindow): BrowserSidebarManager {
  const existing = managers.get(window);
  if (existing) return existing;
  const manager = new BrowserSidebarManager(window, new BrowserSidebarStore(app.getPath("userData")));
  managers.set(window, manager);
  return manager;
}
