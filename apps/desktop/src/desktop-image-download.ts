import path from "node:path";
import type { DownloadItem, Event, WebContents } from "electron";

type SaveResult = { ok: boolean; canceled: boolean; path?: string; error?: string };
const activeDownloads = new Set<number>();

/** Chromium streams the image and owns the native save dialog; the page never navigates. */
export function saveImageDownload(contents: WebContents, payload: unknown, downloadsDirectory: string): Promise<SaveResult> {
  const input = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const url = typeof input.url === "string" ? input.url : "";
  let parsed: URL;
  try { parsed = new URL(url); } catch { return Promise.resolve({ ok: false, canceled: false, error: "Invalid image URL." }); }
  if (!["http:", "https:", "blob:", "data:"].includes(parsed.protocol) ||
      (parsed.protocol === "data:" && !/^data:image\//i.test(url))) {
    return Promise.resolve({ ok: false, canceled: false, error: "Unsupported image URL." });
  }
  if (contents.isDestroyed() || activeDownloads.has(contents.id)) {
    return Promise.resolve({ ok: false, canceled: false, error: "An image save is already in progress or the window is closed." });
  }
  const name = typeof input.suggestedName === "string" ? path.basename(input.suggestedName.replace(/\\/g, "/")).trim() : "";
  const suggestedName = name && !/[\x00-\x1f]/.test(name) && name !== "." && name !== ".." ? name : "image.png";
  const senderId = contents.id;
  const session = contents.session;
  activeDownloads.add(senderId);
  return new Promise((resolve) => {
    let item: DownloadItem | null = null;
    let settled = false;
    const finish = (result: SaveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      session.removeListener("will-download", onDownload);
      contents.removeListener("destroyed", onDestroyed);
      activeDownloads.delete(senderId);
      resolve(result);
    };
    const onDestroyed = () => { item?.cancel(); finish({ ok: false, canceled: true }); };
    const onDownload = (_event: Event, download: DownloadItem, owner: WebContents) => {
      if (owner?.id !== senderId || !download.getURLChain().includes(url)) return;
      item = download;
      clearTimeout(timeout);
      session.removeListener("will-download", onDownload);
      const mime = download.getMimeType();
      if (mime && !mime.startsWith("image/") && mime !== "application/octet-stream") {
        download.cancel();
        finish({ ok: false, canceled: false, error: "The server did not return an image." });
        return;
      }
      // Do not setSavePath: Electron must ask the user where to save every image.
      download.setSaveDialogOptions({ title: "Save image", defaultPath: path.join(downloadsDirectory, suggestedName) });
      download.once("done", (_doneEvent, state) => finish(state === "completed"
        ? { ok: true, canceled: false, path: download.getSavePath() }
        : { ok: false, canceled: state === "cancelled", ...(state === "cancelled" ? {} : { error: "Image download failed. Please retry." }) }));
    };
    const timeout = setTimeout(() => finish({ ok: false, canceled: false, error: "Image download did not start. Please retry." }), 30_000);
    timeout.unref?.();
    session.on("will-download", onDownload);
    contents.once("destroyed", onDestroyed);
    try { contents.downloadURL(url); } catch { finish({ ok: false, canceled: false, error: "Image download could not start." }); }
  });
}
