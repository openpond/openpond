import type { BrowserImageCapture } from "@openpond/contracts/browser-snapshots";
import { Copy, Download, X } from "../icons";
import { copyToClipboard } from "../../lib/clipboard";
import { useAppToast } from "../../app/AppToastContext";

export function BrowserSnapshotPreview({ image, onClose }: { image: BrowserImageCapture; onClose(): void }) {
  const toast = useAppToast();
  const htmlLabel = image.source?.length === 64_000 ? "HTML excerpt" : "HTML";
  async function download() {
    const name = `${image.selector.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "snapshot"}.png`;
    if (window.openpond?.files?.saveImage) {
      const result = await window.openpond.files.saveImage({ url: image.dataUrl, suggestedName: name });
      if (!result.ok && !result.canceled) toast?.(result.error ?? "Snapshot could not be saved.", "error");
    } else {
      const link = document.createElement("a"); link.href = image.dataUrl; link.download = name; link.click();
    }
  }
  return <section className="browser-snapshot-preview" aria-label="Snapshot preview">
    <div className="html-visual-toolbar"><span>{image.selector} · {image.width} × {image.height}</span>
      {image.source ? <button type="button" aria-label={`Copy ${htmlLabel}`} title={`Copy ${htmlLabel}`} onClick={() => void copyToClipboard(image.source!)}><Copy size={15} /></button> : null}
      <button type="button" aria-label="Save snapshot PNG" title="Save snapshot PNG" onClick={() => void download()}><Download size={15} /></button>
      <button type="button" aria-label="Close snapshot" title="Close snapshot" onClick={onClose}><X size={15} /></button>
    </div>
    <div className="browser-snapshot-image"><img src={image.dataUrl} alt={`Snapshot of ${image.selector}`} /></div>
    {image.source ? <details><summary>{htmlLabel}</summary><pre>{image.source}</pre></details> : null}
  </section>;
}
