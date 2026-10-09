import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { describe, expect, test } from "vitest";
import { assertTrustedDesktopIpcEvent, isTrustedDesktopIpcFrameUrl, isTrustedDesktopIpcRequest } from "../apps/desktop/src/desktop-ipc-trust";

describe("desktop IPC origin trust", () => {
  test("accepts only the configured development origin", () => {
    const base = {
      packaged: false,
      trustedRendererUrl: "http://127.0.0.1:17876/",
    };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17876/chat#one" })).toBe(true);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://localhost:17876/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://example.com/" })).toBe(false);
  });

  test("accepts only the configured packaged loopback origin", () => {
    const base = { packaged: true, trustedRendererUrl: "http://127.0.0.1:17874/" };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17874/chat#one" })).toBe(true);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://localhost:17874/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17875/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://127.0.0.1:17874/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "file:///opt/openpond/resources/web/index.html" })).toBe(false);
  });

  test("rejects a non-loopback renderer even when its origin matches", () => {
    const base = { packaged: true, trustedRendererUrl: "https://example.com/" };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://example.com/chat" })).toBe(false);
  });
});

// A startup failure must leave recovery usable without trusting arbitrary data pages.
describe("startup recovery IPC boundary", () => {
  const startupPageUrl = "data:text/html;charset=utf-8,%3Ch1%3EStartup%20failed%3C%2Fh1%3E";
  const input = { packaged: true, trustedRendererUrl: null, startupPageUrl };

  test("permits recovery only from the exact registered page, before a renderer exists", () => {
    for (const channel of ["openpond:startup:retry", "openpond:logs:open", "openpond:diagnostics:export"]) {
      expect(isTrustedDesktopIpcRequest({ ...input, frameUrl: startupPageUrl, channel })).toBe(true);
      expect(isTrustedDesktopIpcRequest({ ...input, frameUrl: startupPageUrl + "%20", channel })).toBe(false);
      expect(isTrustedDesktopIpcRequest({ ...input, startupPageUrl: null, frameUrl: startupPageUrl, channel })).toBe(false);
    }
    expect(isTrustedDesktopIpcRequest({ ...input, frameUrl: startupPageUrl, channel: "openpond:connection" })).toBe(false);
    expect(isTrustedDesktopIpcRequest({ ...input, frameUrl: startupPageUrl, channel: "openpond:folder:select" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ packaged: false, frameUrl: "data:text/html,other", trustedRendererUrl: startupPageUrl })).toBe(false);
  });

  test("still rejects other windows and subframes on the recovery page", () => {
    const mainFrame = { url: startupPageUrl };
    const sender = { id: 7, mainFrame, getURL: () => startupPageUrl };
    const window = { isDestroyed: () => false, webContents: { id: 7 } } as BrowserWindow;
    const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    const options = { ...input, channel: "openpond:logs:open", window };
    expect(() => assertTrustedDesktopIpcEvent(event, options)).not.toThrow();
    expect(() => assertTrustedDesktopIpcEvent({ ...event, sender: { ...sender, id: 8 } } as unknown as IpcMainInvokeEvent, options)).toThrow("Untrusted IPC sender");
    expect(() => assertTrustedDesktopIpcEvent({ ...event, senderFrame: { url: startupPageUrl } } as IpcMainInvokeEvent, options)).toThrow("Untrusted IPC frame");
  });
});
