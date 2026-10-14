import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, test } from "vitest";
import { captureBrowserPage, cancelBrowserCapture } from "../apps/desktop/src/desktop-native-snapshot";

// Failure story: canceled or navigating tabs must not leave an inspector active
// or deliver pixels from a different page; capture must release its lock so the
// user can retry, without detaching an existing debugger owned by another tool.
test("browser snapshots own their capture lifecycle and cancel on navigation", async () => {
  let attached = false, inspect = false;
  let lastClip: unknown;
  let stalled = false;
  const pngHeader = Buffer.alloc(24);
  pngHeader.writeUInt32BE(1360, 16); pngHeader.writeUInt32BE(6000, 20);
  const png = pngHeader.toString("base64");
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    sendCommand: async (method: string, input?: Record<string, unknown>) => {
      if (method === "DOM.enable" && stalled) return new Promise(() => {});
      if (method === "Overlay.setInspectMode") inspect = input?.mode === "searchForNode";
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { x: 0, y: 0, width: 680, height: 3000 }, cssVisualViewport: { pageX: 10, pageY: 900 } };
      if (method === "DOM.getBoxModel") return { model: { border: [20, 30, 180, 30, 180, 90, 20, 90] } };
      if (method === "DOM.describeNode") return { node: { localName: "button", attributes: ["id", "target"] } };
      if (method === "DOM.getOuterHTML") return { outerHTML: '<button id="target">Capture me</button>' };
      if (method === "Page.captureScreenshot") { lastClip = input?.clip; return { data: png }; }
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

  // Scrolled pages must capture the selected node, rather than unrelated pixels
  // at the same viewport coordinates near the top of the document.
  const selected = captureBrowserPage(contents, "node");
  for (let i = 0; i < 20 && !inspect; i++) await new Promise(resolve => setTimeout(resolve, 0));
  debuggerApi.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 4 });
  expect(await selected).toMatchObject({ ok: true, image: { selector: "button#target", source: '<button id="target">Capture me</button>' } });
  expect(lastClip).toEqual({ x: 30, y: 930, width: 160, height: 60, scale: 1 });
  expect(inspect).toBe(false);

  stalled = true;
  const blocked = captureBrowserPage(contents, "page");
  cancelBrowserCapture(contents);
  expect(await blocked).toMatchObject({ ok: false, canceled: true });
  stalled = false;
  expect((await captureBrowserPage(contents, "page")).ok).toBe(true);
});
