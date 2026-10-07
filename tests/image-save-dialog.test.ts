import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, expect, test, vi } from "vitest";
import { saveImageDownload } from "../apps/desktop/src/desktop-image-download";
import { saveImage } from "../apps/web/src/lib/save-image";

afterEach(() => vi.unstubAllGlobals());

// A download must belong to this window/request, ask for a destination, and
// remain cancelable without navigating the chat or choosing a silent save path.
test("image download uses the native picker and handles cancel, completion and unrelated downloads", async () => {
  const session = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    id: 42, session, isDestroyed: () => false, downloadURL: vi.fn(),
  });
  const url = "http://127.0.0.1:17874/v1/assets/local-image?signature=example";
  const item = () => Object.assign(new EventEmitter(), {
    getURLChain: () => [url], getMimeType: () => "image/png", setSaveDialogOptions: vi.fn(),
    setSavePath: vi.fn(), getSavePath: () => "/tmp/chosen-image.png", cancel: vi.fn(),
  });
  vi.stubGlobal("window", {
    location: { href: "http://localhost/" },
    openpond: { files: { saveImage: (payload: unknown) => saveImageDownload(contents as unknown as WebContents, payload, "/downloads") } },
  });
  let pending = saveImage(url, "../diagram.png");
  const unrelated = item();
  session.emit("will-download", {}, unrelated, { id: 43 });
  expect(unrelated.setSaveDialogOptions).not.toHaveBeenCalled();
  const canceled = item();
  session.emit("will-download", {}, canceled, contents);
  expect(canceled.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "/downloads/diagram.png" }));
  expect(canceled.setSavePath).not.toHaveBeenCalled();
  canceled.emit("done", {}, "cancelled");
  await expect(pending).resolves.toBeUndefined();
  expect(session.listenerCount("will-download")).toBe(0);

  pending = saveImage(url, "diagram.png");
  const saved = item();
  session.emit("will-download", {}, saved, contents);
  saved.emit("done", {}, "completed");
  await expect(pending).resolves.toBeUndefined();
  expect(contents.downloadURL).toHaveBeenCalledTimes(2);
  expect(contents.listenerCount("destroyed")).toBe(0);
  await expect(saveImage("javascript:alert(1)", "diagram.png")).rejects.toThrow("Unsupported image URL");
  expect(contents.downloadURL).toHaveBeenCalledTimes(2);
});

// Browser picker activation must occur before asynchronous network work, and
// canceling the picker must not fetch or save the image.
test("browser save opens the picker before loading bytes and respects cancellation", async () => {
  const order: string[] = [];
  const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  const picker = vi.fn(async () => { order.push("picker"); return { createWritable: async () => writable }; });
  vi.stubGlobal("window", { showSaveFilePicker: picker });
  const fetchImage = vi.fn(async () => { order.push("fetch"); return new Response(new Blob(["image"], { type: "image/png" })); });
  vi.stubGlobal("fetch", fetchImage);
  await saveImage("https://example.test/image.png", "image.png");
  expect(order).toEqual(["picker", "fetch"]);
  expect(writable.write).toHaveBeenCalledWith(expect.any(Blob));
  expect(writable.close).toHaveBeenCalledOnce();
  picker.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
  await saveImage("https://example.test/image.png", "image.png");
  expect(fetchImage).toHaveBeenCalledOnce();
});
