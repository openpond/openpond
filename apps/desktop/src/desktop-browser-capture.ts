import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { BrowserDomCaptureSchema, type BrowserCaptureResult } from "@openpond/contracts/browser-snapshots";

export { captureBrowserPage, cancelBrowserCapture } from "./desktop-native-snapshot.js";

const capturing = new Set<number>();

export async function captureHtmlSnapshot(input: unknown, ownerId: number): Promise<BrowserCaptureResult> {
  const capture = BrowserDomCaptureSchema.parse(input);
  if (!capture.html || Buffer.byteLength(capture.html) > 6 * 1024 * 1024) throw new Error("Snapshot HTML is missing or too large.");
  if (capturing.has(ownerId)) throw new Error("A snapshot is already rendering. Try again when it finishes.");
  const isolated = session.fromPartition(`html-snapshot-${randomUUID()}`);
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") && !details.url.startsWith("about:") }));
  const window = new BrowserWindow({ show: false, width: Math.ceil(capture.rect.width), height: Math.ceil(capture.rect.height), webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  capturing.add(ownerId);
  const timeout = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 15_000);
  try {
    const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;overflow:hidden}</style></head><body>${capture.html}</body></html>`)}`);
    await window.webContents.executeJavaScript("Promise.all([document.fonts.ready,...[...document.images].map(image=>image.decode().catch(()=>{}))]).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error("The snapshot could not be rendered.");
    const dataUrl = image.toDataURL();
    if (dataUrl.length > 28_000_000) throw new Error("The snapshot is too large to save.");
    return { ok: true, image: { dataUrl, ...image.getSize(), selector: capture.selector, source: capture.source } };
  } finally {
    capturing.delete(ownerId);
    clearTimeout(timeout); if (!window.isDestroyed()) window.destroy();
    await isolated.clearStorageData(); await isolated.clearCache();
  }
}
