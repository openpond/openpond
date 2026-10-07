import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "../icons";
import { saveImage } from "../../lib/save-image";

export function ImageLightbox({
  open,
  src,
  title,
  onClose,
}: {
  open: boolean;
  src: string | null;
  title: string;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    setFailed(false);
    setSaveError(null);
  }, [src]);

  if (!open || !src) return null;

  const downloadFileName = (() => {
    const fromTitle = title.split("/").pop()?.trim();
    if (fromTitle && /\.[A-Za-z0-9]+$/.test(fromTitle)) return fromTitle;
    try {
      const url = new URL(src, window.location.href);
      const filePath = url.searchParams.get("path") ?? url.searchParams.get("storageName") ?? url.pathname;
      const fromUrl = filePath.split(/[\\/]/).pop()?.trim();
      if (fromUrl && /\.[A-Za-z0-9]+$/.test(fromUrl)) return fromUrl;
    } catch { /* ignore */ }
    return "image.png";
  })();

  const handleDownload = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try { await saveImage(src, downloadFileName); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Could not save image."); }
    finally { setSaving(false); }
  };

  // Chat rows use rendering containment; mount outside them to cover the viewport.
  return createPortal(
    <div
      className="image-lightbox-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={title ? `Image preview: ${title}` : "Image preview"}
        aria-modal="true"
        className="image-lightbox-dialog"
        role="dialog"
      >
        <header className="image-lightbox-header">
          <span title={title}>{title}</span>
          <div className="image-lightbox-actions">
            <button
              type="button"
              aria-label="Download image"
              title="Download"
              disabled={saving}
              aria-busy={saving}
              onClick={handleDownload}
            >
              <Download size={16} />
            </button>
            <button type="button" aria-label="Close image preview" title="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        {saveError && <div className="image-lightbox-error" role="alert">{saveError}</div>}
        <div className="image-lightbox-frame">
          {failed ? (
            <div className="image-lightbox-error">Image preview unavailable</div>
          ) : (
            <img
              alt={title || "Image preview"}
              decoding="async"
              draggable={false}
              src={src}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
