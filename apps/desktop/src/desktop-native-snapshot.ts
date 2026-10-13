import type { WebContents } from "electron";
import { BrowserCaptureRectSchema, type BrowserCaptureMode, type BrowserCaptureResult, type BrowserDomCapture } from "@openpond/contracts/browser-snapshots";
import { HTML_VISUAL_THEME } from "@openpond/contracts/html-visuals";
import { snapshotImage } from "./desktop-snapshot-image.js";

const pending = new Map<number, AbortController>();
export function cancelBrowserCapture(contents: WebContents) { pending.get(contents.id)?.abort(); }

export async function captureBrowserPage(contents: WebContents, mode: BrowserCaptureMode): Promise<BrowserCaptureResult> {
  if (pending.has(contents.id)) return { ok: false, error: "A snapshot is already in progress." };
  const controller = new AbortController(); pending.set(contents.id, controller);
  const timeout = setTimeout(() => controller.abort(), mode === "node" ? 120_000 : 30_000);
  let attached = false;
  const onNavigation = () => controller.abort();
  contents.on("did-start-navigation", onNavigation);
  contents.once("destroyed", onNavigation);
  contents.debugger.on("detach", onNavigation);
  const send = (method: string, params?: Record<string, unknown>) => captureCommand(contents, controller.signal, method, params);
  try {
    if (!contents.debugger.isAttached()) { contents.debugger.attach("1.3"); attached = true; }
    await send("DOM.enable");
    await send("Page.enable");
    let capture: BrowserDomCapture;
    if (mode === "node") capture = await selectNode(contents, controller.signal);
    else {
      const metrics = await send("Page.getLayoutMetrics");
      capture = { rect: BrowserCaptureRectSchema.parse(metrics.cssContentSize), selector: "Full page" };
    }
    controller.signal.throwIfAborted();
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...capture.rect, scale: 1 } });
    controller.signal.throwIfAborted();
    if (screenshot.data.length > 28_000_000) throw new Error("The snapshot is too large to save.");
    return { ok: true, image: snapshotImage(`data:image/png;base64,${screenshot.data}`, { selector: capture.selector, source: capture.source }) };
  } catch (error) {
    return controller.signal.aborted || (error instanceof Error && error.name === "AbortError") ? { ok: false, canceled: true, error: "Snapshot canceled." }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    contents.removeListener("did-start-navigation", onNavigation); contents.removeListener("destroyed", onNavigation);
    contents.debugger.removeListener("detach", onNavigation);
    if (!contents.isDestroyed() && contents.debugger.isAttached()) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        contents.debugger.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => {}),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1_000); }),
      ]);
      clearTimeout(cleanupTimer);
      if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    }
    pending.delete(contents.id);
  }
}

async function selectNode(contents: WebContents, signal: AbortSignal): Promise<BrowserDomCapture> {
  contents.focus();
  const debuggerApi = contents.debugger;
  const send = (method: string, params?: Record<string, unknown>) => captureCommand(contents, signal, method, params);
  await send("Overlay.enable");
  const hex = HTML_VISUAL_THEME["--blue"].replace("#", "");
  const color = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 0.25 };
  const backendNodeId = await new Promise<number>((resolve, reject) => {
    const finish = (id?: number, error?: Error) => {
      debuggerApi.removeListener("message", message); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(id!);
    };
    const abort = () => finish(undefined, new DOMException("Snapshot canceled.", "AbortError"));
    const message = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
      if (method === "Overlay.inspectNodeRequested" && typeof params.backendNodeId === "number") finish(params.backendNodeId);
      else if (method === "Overlay.inspectModeCanceled") abort();
    };
    debuggerApi.on("message", message); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: { showInfo: true, showStyles: true, contentColor: color, borderColor: { ...color, a: 1 } } })
      .catch(error => finish(undefined, error instanceof Error ? error : new Error(String(error))));
  });
  await send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
  await send("Overlay.hideHighlight");
  const box = await send("DOM.getBoxModel", { backendNodeId });
  const points = box.model.border as number[];
  const xs = points.filter((_value, index) => index % 2 === 0), ys = points.filter((_value, index) => index % 2 === 1);
  const metrics = await send("Page.getLayoutMetrics");
  const { pageX, pageY } = metrics.cssVisualViewport;
  // DOM quads use viewport coordinates; screenshot clips use page coordinates.
  const x = Math.max(0, Math.min(...xs) + pageX), y = Math.max(0, Math.min(...ys) + pageY);
  const node = (await send("DOM.describeNode", { backendNodeId })).node;
  const attributes = node.attributes as string[] | undefined;
  const idIndex = attributes?.indexOf("id") ?? -1;
  const source = (await send("DOM.getOuterHTML", { backendNodeId })).outerHTML as string;
  return { rect: BrowserCaptureRectSchema.parse({ x, y, width: Math.ceil(Math.max(...xs) + pageX - x), height: Math.ceil(Math.max(...ys) + pageY - y) }),
    selector: `${node.localName || node.nodeName}${idIndex >= 0 ? `#${attributes![idIndex + 1]}` : ""}`.slice(0, 500), source: source.slice(0, 64_000) };
}

function captureCommand(contents: WebContents, signal: AbortSignal, method: string, params?: Record<string, unknown>): ReturnType<WebContents["debugger"]["sendCommand"]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Snapshot canceled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    contents.debugger.sendCommand(method, params).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
