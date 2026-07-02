import { useCallback, useLayoutEffect, useRef } from "react";

export function BrowserViewport({
  active,
  onBounds,
}: {
  active: boolean;
  onBounds: (bounds: BrowserBounds | null) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const reportBounds = useCallback(() => {
    const element = viewportRef.current;
    if (!active || !element) {
      onBounds(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width));
    const height = Math.max(0, Math.round(rect.height));
    if (width === 0 || height === 0) {
      onBounds(null);
      return;
    }
    onBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
    });
  }, [active, onBounds]);

  useLayoutEffect(() => {
    reportBounds();
    const element = viewportRef.current;
    if (!active || !element) {
      onBounds(null);
      return () => onBounds(null);
    }
    const observer = new ResizeObserver(reportBounds);
    observer.observe(element);
    window.addEventListener("resize", reportBounds);
    window.addEventListener("scroll", reportBounds, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      window.removeEventListener("scroll", reportBounds, true);
      onBounds(null);
    };
  }, [active, onBounds, reportBounds]);

  return <div className="browser-viewport" ref={viewportRef} />;
}
