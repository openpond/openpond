import { useEffect, useState } from "react";
import { X } from "../icons";

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
          <button type="button" aria-label="Close image preview" onClick={onClose}>
            <X size={16} />
          </button>
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
