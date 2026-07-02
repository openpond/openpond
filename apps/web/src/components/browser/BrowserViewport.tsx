import { useCallback, useLayoutEffect, useRef } from "react";

export function BrowserViewport({
  active,
  onBounds,
}: {
  active: boolean;
  onBounds: (bounds: BrowserBounds | null) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastBoundsKeyRef = useRef<string | null>(null);
  const reportFrameRef = useRef<number | null>(null);

  const emitBounds = useCallback((bounds: BrowserBounds | null) => {
    const key = bounds
      ? `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
      : "null";
    if (lastBoundsKeyRef.current === key) return;
    lastBoundsKeyRef.current = key;
    onBounds(bounds);
  }, [onBounds]);

  const reportBounds = useCallback(() => {
    const element = viewportRef.current;
    if (!active || !element) {
      emitBounds(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width));
    const height = Math.max(0, Math.round(rect.height));
    if (width === 0 || height === 0) {
      emitBounds(null);
      return;
    }
    emitBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
    });
  }, [active, emitBounds]);

  const scheduleReportBounds = useCallback(() => {
    if (reportFrameRef.current !== null) return;
    reportFrameRef.current = window.requestAnimationFrame(() => {
      reportFrameRef.current = null;
      reportBounds();
    });
  }, [reportBounds]);

  useLayoutEffect(() => {
    lastBoundsKeyRef.current = null;
    reportBounds();
    const element = viewportRef.current;
    if (!active || !element) {
      emitBounds(null);
      return () => emitBounds(null);
    }
    const observer = new ResizeObserver(scheduleReportBounds);
    observer.observe(element);
    window.addEventListener("resize", scheduleReportBounds);
    window.addEventListener("scroll", scheduleReportBounds, true);
    return () => {
      if (reportFrameRef.current !== null) {
        window.cancelAnimationFrame(reportFrameRef.current);
        reportFrameRef.current = null;
      }
      observer.disconnect();
      window.removeEventListener("resize", scheduleReportBounds);
      window.removeEventListener("scroll", scheduleReportBounds, true);
      emitBounds(null);
    };
  }, [active, emitBounds, reportBounds, scheduleReportBounds]);

  return <div className="browser-viewport" ref={viewportRef} />;
}
