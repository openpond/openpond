import { useCallback, useEffect, useImperativeHandle, useRef, type Ref, type RefObject } from "react";
import { BrowserDomCaptureSchema, type BrowserCaptureMode, type BrowserDomCapture } from "@openpond/contracts/browser-snapshots";

export type HtmlVisualSnapshotHandle = { capture(mode: BrowserCaptureMode): Promise<BrowserDomCapture>; cancel(): void };

export function useHtmlVisualSnapshot(frame: RefObject<HTMLIFrameElement | null>, identity: string, ready: boolean, ref?: Ref<HtmlVisualSnapshotHandle>) {
  const readiness = useRef(ready); readiness.current = ready;
  const pending = useRef<{ id: string; resolve(value: BrowserDomCapture): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const cancel = useCallback(() => {
    const request = pending.current;
    if (!request) return;
    pending.current = null; clearTimeout(request.timeout);
    frame.current?.contentWindow?.postMessage({ type: "openpond-snapshot-command", identity, requestId: request.id, action: "cancel" }, "*");
    request.reject(new DOMException("Snapshot canceled.", "AbortError"));
  }, [frame, identity]);
  useEffect(() => cancel, [cancel]);
  useImperativeHandle(ref, () => ({ cancel, capture: mode => {
    if (!readiness.current || !frame.current?.contentWindow) return Promise.reject(new Error("Wait for the HTML page to finish loading."));
    cancel();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      if (mode === "node") frame.current!.focus();
      pending.current = { id, resolve, reject, timeout: setTimeout(cancel, mode === "node" ? 120_000 : 15_000) };
      frame.current!.contentWindow!.postMessage({ type: "openpond-snapshot-command", identity, requestId: id, action: mode }, "*");
    });
  } }), [cancel, frame, identity]);
  return useCallback((data: { requestId?: string; capture?: unknown; canceled?: boolean; error?: string }) => {
    const request = pending.current;
    if (!request || request.id !== data.requestId) return;
    if (data.canceled) { cancel(); return; }
    pending.current = null; clearTimeout(request.timeout);
    const parsed = BrowserDomCaptureSchema.safeParse(data.capture);
    if (data.error || !parsed.success || !parsed.data.html) request.reject(new Error(data.error ?? "The HTML snapshot could not be captured."));
    else request.resolve(parsed.data);
  }, [cancel]);
}
