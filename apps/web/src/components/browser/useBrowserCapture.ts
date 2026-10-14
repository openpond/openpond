import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserCaptureMode, BrowserImageCapture } from "@openpond/contracts/browser-snapshots";
import type { HtmlVisualSnapshotHandle } from "../visuals/useHtmlVisualSnapshot";

export function useBrowserCapture(conversationId: string, tabId: string | null, visualId: string | null, visual: React.RefObject<HtmlVisualSnapshotHandle | null>) {
  const [busy, setBusy] = useState<BrowserCaptureMode | null>(null);
  const [image, setImage] = useState<BrowserImageCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const cancelOperation = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    generation.current++;
    cancelOperation.current?.(); cancelOperation.current = null;
    setBusy(null);
  }, []);
  useEffect(() => { setImage(null); setError(null); return cancel; }, [conversationId, tabId, visualId, cancel]);
  useEffect(() => {
    if (busy !== "node") return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, cancel]);
  const capture = useCallback(async (mode: BrowserCaptureMode) => {
    cancel();
    const operation = generation.current;
    setImage(null); setError(null); setBusy(mode);
    try {
      const bridge = window.openpond?.browser;
      if (!bridge) throw new Error("Snapshots are available in the desktop app.");
      let result;
      if (visualId) {
        const handle = visual.current;
        if (!handle) throw new Error("Wait for the HTML page to finish loading.");
        cancelOperation.current = () => handle.cancel();
        const document = await handle.capture(mode);
        if (operation !== generation.current) return;
        result = await bridge.captureHtml(document);
      } else {
        if (!tabId) throw new Error("Open a browser page before taking a snapshot.");
        const input = { conversationId, tabId };
        cancelOperation.current = () => { void bridge.cancelCapture(input); };
        result = await bridge.capturePage({ ...input, mode });
      }
      if (operation !== generation.current) return;
      if (result.ok) setImage(result.image);
      else if (!result.canceled) setError(result.error);
    } catch (cause) {
      if (operation === generation.current && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Snapshot failed.");
      }
    } finally {
      if (operation === generation.current) { setBusy(null); cancelOperation.current = null; }
    }
  }, [cancel, conversationId, tabId, visualId, visual]);
  return { busy, image, error, capture, cancel, close: () => setImage(null) };
}
