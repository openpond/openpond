import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, test } from "vitest";
import { captureBrowserPage, cancelBrowserCapture } from "../apps/desktop/src/desktop-native-snapshot";

// Failure story: canceled or navigating tabs must not leave an inspector active
// or deliver pixels from a different page; capture must release its lock so the
// user can retry, without detaching an existing debugger owned by another tool.
test("browser snapshots own their capture lifecycle and cancel on navigation", async () => {
  let attached = false, inspect = false;
  const pngHeader = Buffer.alloc(24);
  pngHeader.writeUInt32BE(1360, 16); pngHeader.writeUInt32BE(6000, 20);
  const png = pngHeader.toString("base64");
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    sendCommand: async (method: string, input?: Record<string, unknown>) => {
      if (method === "Overlay.setInspectMode") inspect = input?.mode === "searchForNode";
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: 680, height: 3000 } };
      if (method === "Page.captureScreenshot") return { data: png };
      return {};
    },
  });
  const contents = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false, focus: () => {}, debugger: debuggerApi }) as unknown as WebContents;
  const selecting = captureBrowserPage(contents, "node");
  for (let i = 0; i < 20 && !inspect; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(inspect).toBe(true);
  expect((await captureBrowserPage(contents, "page")).ok).toBe(false);
  cancelBrowserCapture(contents);
  expect(await selecting).toMatchObject({ ok: false, canceled: true });
  expect(inspect).toBe(false);
  expect(attached).toBe(false);
  expect(debuggerApi.listenerCount("message")).toBe(0);

  attached = true;
  const page = await captureBrowserPage(contents, "page");
  expect(page).toMatchObject({ ok: true, image: { width: 1360, height: 6000, dataUrl: `data:image/png;base64,${png}` } });
  expect(attached).toBe(true);
  const navigating = captureBrowserPage(contents, "node");
  for (let i = 0; i < 20 && !inspect; i++) await new Promise(resolve => setTimeout(resolve, 0));
  contents.emit("did-start-navigation");
  expect(await navigating).toMatchObject({ ok: false, canceled: true });
  expect(inspect).toBe(false);
  expect(contents.listenerCount("did-start-navigation")).toBe(0);
  expect(debuggerApi.listenerCount("message")).toBe(0);
});
