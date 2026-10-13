import { useEffect, useId, useRef, useState } from "react";
import type { WorkspaceDiffFile } from "@openpond/contracts";
import { FileText } from "../icons";
import { isPresentationFile } from "./workspace-diff-panel-model";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { queueThumbnailPreview } from "./preview-work-queue";

export default function FilePagePreview({ file, thumbnail = true }: { file: WorkspaceDiffFile; thumbnail?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const className = `word-preview-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !file.content) return;
    const controller = new AbortController();
    const stage = document.createElement("div");
    host.replaceChildren(stage);
    const disposers: (() => void)[] = [];
    setReady(false);
    setFailed(false);
    const fit = () => {
      const width = stage.offsetWidth;
      if (!width) return;
      const pageHeight = stage.scrollHeight;
      const availableHeight = thumbnail ? host.parentElement?.clientHeight ?? 0 : 0;
      const scale = thumbnail && availableHeight && pageHeight
        ? Math.min(host.clientWidth / width, availableHeight / pageHeight) : host.clientWidth / width;
      stage.style.zoom = String(scale);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    if (thumbnail && host.parentElement) observer.observe(host.parentElement);
    const render = async () => {
      const bytes = Uint8Array.from(atob(file.content!), value => value.charCodeAt(0));
      if (isPresentationFile(file)) {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
        if (controller.signal.aborted) return;
        stage.style.width = "320px";
        const viewer = new PptxViewer(stage, { width: 320, zipLimits: RECOMMENDED_ZIP_LIMITS, lazySlides: true, lazyMedia: true, pdfjs: false });
        disposers.push(() => viewer.destroy());
        await viewer.open(bytes, { signal: controller.signal, renderMode: "slide" });
      } else if (/\.pdf$/i.test(file.path)) {
        const pdfjs = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({ data: bytes });
        disposers.push(() => { void task.destroy().catch(() => {}); });
        const pdf = await task.promise;
        if (controller.signal.aborted) return;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 320 / page.getViewport({ scale: 1 }).width });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        stage.style.width = "320px";
        stage.appendChild(canvas);
        const rendering = page.render({ canvas, viewport });
        disposers.push(() => rendering.cancel());
        await rendering.promise;
      } else {
        const [{ renderAsync }, { parseZipLazyMedia, RECOMMENDED_ZIP_LIMITS }] = await Promise.all([
          import("docx-preview"), import("@aiden0z/pptx-renderer"),
        ]);
        // OOXML uses the same ZIP container. Check its expansion limits before
        // handing the Word archive to a renderer without its own ZIP limits.
        await parseZipLazyMedia(bytes.buffer, RECOMMENDED_ZIP_LIMITS);
        if (controller.signal.aborted) return;
        stage.style.width = "816px";
        await renderAsync(bytes, stage, stage, { className, inWrapper: false, breakPages: true, useBase64URL: true,
          renderHeaders: true, renderFooters: true, renderFootnotes: !thumbnail, renderEndnotes: !thumbnail });
        if (thumbnail) Array.from(stage.querySelectorAll(`section.${className}`)).slice(1).forEach(page => page.remove());
      }
      if (!controller.signal.aborted) { fit(); setReady(true); }
    };
    void (thumbnail ? queueThumbnailPreview(controller.signal, render) : render())
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      observer.disconnect();
      disposers.reverse().forEach(dispose => dispose());
      stage.remove();
    };
  }, [className, file.content, file.path, thumbnail]);
  return <div className={`file-page-preview ${thumbnail ? "thumbnail" : "document"}`}>
    {!ready ? <span className="file-page-preview-placeholder" role={thumbnail ? undefined : "status"}>
      {thumbnail ? <FileText size={28} /> : failed ? "Preview unavailable. Download the original document to open it." : "Loading document…"}
    </span> : null}
    <div ref={hostRef} className={`file-page-preview-content ${ready && !failed ? "ready" : ""}`} />
  </div>;
}
