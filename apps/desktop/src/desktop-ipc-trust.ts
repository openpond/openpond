import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export function isTrustedDesktopIpcFrameUrl(input: {
  frameUrl: string;
  packaged: boolean;
  trustedRendererUrl: string | null;
}): boolean {
  if (!input.frameUrl || !input.trustedRendererUrl) return false;
  try {
    const frame = new URL(input.frameUrl);
    const trusted = new URL(input.trustedRendererUrl);
    if (input.packaged && !isLoopbackHttpUrl(trusted)) return false;
    return frame.origin !== "null" && frame.origin === trusted.origin;
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}

const STARTUP_PAGE_CHANNELS = new Set([
  "openpond:startup:retry",
  "openpond:desktop:restart",
  "openpond:logs:open",
  "openpond:diagnostics:export",
]);

export function isTrustedDesktopIpcRequest(input: {
  frameUrl: string;
  packaged: boolean;
  trustedRendererUrl: string | null;
  startupPageUrl: string | null;
  channel: string;
}): boolean {
  if (input.startupPageUrl && input.frameUrl === input.startupPageUrl) {
    return STARTUP_PAGE_CHANNELS.has(input.channel);
  }
  return isTrustedDesktopIpcFrameUrl(input);
}

export function assertTrustedDesktopIpcEvent(event: IpcMainInvokeEvent, input: {
  window: BrowserWindow | null;
  packaged: boolean;
  trustedRendererUrl: string | null;
  startupPageUrl: string | null;
  channel: string;
}): void {
  const window = input.window;
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
    throw new Error("Untrusted IPC sender.");
  }
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Untrusted IPC frame.");
  }
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedDesktopIpcRequest({ ...input, frameUrl })) {
    throw new Error("Untrusted IPC origin.");
  }
}
