import type { BrowserImageCapture } from "@openpond/contracts/browser-snapshots";

export function snapshotImage(dataUrl: string, metadata: Pick<BrowserImageCapture, "selector" | "source">): BrowserImageCapture {
  // The PNG's dimensions remain authoritative on high-DPI displays.
  const header = Buffer.from(dataUrl.slice("data:image/png;base64,".length, "data:image/png;base64,".length + 32), "base64");
  if (header.length < 24) throw new Error("The snapshot image is invalid.");
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (!width || !height || width * height > 40_000_000) throw new Error("The snapshot image is too large.");
  return { dataUrl, width, height, ...metadata };
}
