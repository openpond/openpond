import { useEffect, useState } from "react";
import { Download, X } from "../icons";

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
  }, [src]);

  if (!open || !src) return null;

  const downloadFileName = (() => {
    const fromTitle = title.split("/").pop()?.trim();
    if (fromTitle && /\.[A-Za-z0-9]+$/.test(fromTitle)) return fromTitle;
    try {
      const url = new URL(src, window.location.href);
      const fromUrl = url.pathname.split("/").pop()?.trim();
      if (fromUrl && /\.[A-Za-z0-9]+$/.test(fromUrl)) return fromUrl;
    } catch { /* ignore */ }
    return "image.png";
  })();

  const handleDownload = () => {
    const anchor = document.createElement("a");
    anchor.href = src;
    anchor.download = downloadFileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
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
              onClick={handleDownload}
            >
              <Download size={16} />
            </button>
            <button type="button" aria-label="Close image preview" title="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
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
    </div>
  );
}
