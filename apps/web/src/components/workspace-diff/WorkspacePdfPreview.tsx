import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useErrorToast } from "../../app/AppToastContext";

export default function WorkspacePdfPreview({ contentBase64 }: { contentBase64: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<{ content: string; pdf: PDFDocumentProxy; ratio: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useErrorToast(error, { prefix: "PDF preview" });
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(0, node.clientWidth - 32)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    let destroy: (() => void) | undefined;
    setDocument(null);
    setError(null);
    void import("pdfjs-dist").then(async pdfjs => {
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const task = pdfjs.getDocument({ data: Uint8Array.from(atob(contentBase64), character => character.charCodeAt(0)) });
      destroy = () => { void task.destroy().catch(() => {}); };
      const pdf = await task.promise;
      if (disposed) return;
      const firstPage = await pdf.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });
      if (!disposed) setDocument({ content: contentBase64, pdf, ratio: viewport.height / viewport.width });
    }).catch(reason => { if (!disposed) setError(reason); });
    return () => { disposed = true; destroy?.(); };
  }, [contentBase64, attempt]);
  const pdf = document?.content === contentBase64 ? document.pdf : null;
  return <div ref={host} className="workspace-pdf-preview" role="region" aria-label="PDF pages">
    {pdf && width > 0 ? Array.from({ length: pdf.numPages }, (_, index) =>
      <PdfPage key={`${attempt}:${index}`} pdf={pdf} pageNumber={index + 1} width={width} initialRatio={document!.ratio} />)
      : error ? <button type="button" className="toolbar-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button>
      : <span role="status">Loading document…</span>}
  </div>;
}

// Keep offscreen pages as placeholders. Large decks should not allocate a
// full-resolution canvas for every page, and resizing cancels stale renders.
function PdfPage({ pdf, pageNumber, width, initialRatio }: { pdf: PDFDocumentProxy; pageNumber: number; width: number; initialRatio: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(initialRatio);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useErrorToast(error, { prefix: `PDF page ${pageNumber}` });
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)),
      { root: node.closest(".workspace-pdf-preview"), rootMargin: "600px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = host.current;
    if (!visible || !node) return;
    let disposed = false;
    let rendering: RenderTask | undefined;
    let page: PDFPageProxy | undefined;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", `Page ${pageNumber}`);
    canvas.setAttribute("role", "img");
    setError(null);
    void pdf.getPage(pageNumber).then(async result => {
      if (disposed) return;
      page = result;
      const base = page.getViewport({ scale: 1 });
      const nextRatio = base.height / base.width;
      setRatio(nextRatio);
      const density = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: width * density / base.width });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${width * nextRatio}px`;
      rendering = page.render({ canvas, viewport });
      await rendering.promise;
      if (!disposed) node.appendChild(canvas);
    }).catch(reason => { if (!disposed) setError(reason); });
    return () => {
      disposed = true;
      rendering?.cancel();
      canvas.remove();
      if (rendering) void rendering.promise.catch(() => {}).then(() => page?.cleanup());
      else page?.cleanup();
    };
  }, [pdf, pageNumber, visible, width, attempt]);
  return <div ref={host} className="workspace-pdf-page" style={{ height: width * ratio }}>
    {error ? <button type="button" className="toolbar-button" onClick={() => setAttempt(value => value + 1)}>Retry page {pageNumber}</button> : null}
  </div>;
}
