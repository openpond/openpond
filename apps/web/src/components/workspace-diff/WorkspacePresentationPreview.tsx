import { useEffect, useMemo, useRef, useState } from "react";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import { Download } from "../icons";

const PRESENTATION_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export default function WorkspacePresentationPreview({ path, contentBase64 }: { path: string; contentBase64: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const filename = path.replace(/\\/g, "/").split("/").pop() || "presentation";
  const downloadName = /\.pptx$/i.test(filename) ? filename : `${filename}.pptx`;
  const bytes = useMemo(() => {
    try { return Uint8Array.from(atob(contentBase64.replace(/\s/g, "")), character => character.charCodeAt(0)); }
    catch { return null; }
  }, [contentBase64]);
  const [state, setState] = useState<{ source: typeof bytes; count: number; error: string | null; url: string | null }>({ source: null, count: 0, error: null, url: null });
  const current = state.source === bytes ? state : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !bytes) return;
    const controller = new AbortController();
    // Each effect owns a separate stage so an obsolete async render cannot
    // overwrite the next deck, including during StrictMode effect replay.
    const stage = document.createElement("div");
    host.replaceChildren(stage);
    const url = URL.createObjectURL(new Blob([bytes], { type: PRESENTATION_CONTENT_TYPE }));
    const viewer = new PptxViewer(stage, { fitMode: "contain", scrollContainer: host, zipLimits: RECOMMENDED_ZIP_LIMITS, lazySlides: true, lazyMedia: true, pdfjs: false });
    setState({ source: bytes, count: 0, error: null, url });
    void viewer.open(bytes.buffer, { signal: controller.signal, renderMode: "list", listOptions: { windowed: true, initialSlides: 3, batchSize: 3 } })
      .then(() => {
        if (!controller.signal.aborted) setState({ source: bytes, count: viewer.slideCount, error: viewer.slideCount ? null : "This presentation contains no slides.", url });
      })
      .catch(error => {
        if (!controller.signal.aborted) setState({ source: bytes, count: 0, error: error instanceof Error ? error.message : "Could not render this presentation.", url });
      });
    return () => {
      controller.abort();
      viewer.destroy();
      stage.remove();
      URL.revokeObjectURL(url);
    };
  }, [bytes]);

  return <div className="workspace-document-preview workspace-presentation-preview">
    <div className="workspace-document-preview-card">
      <strong title={path}>{downloadName}</strong>
      <span>{current?.count ? `${current.count} slides` : "PowerPoint presentation"}</span>
      {current?.url ? <a href={current.url} download={downloadName} aria-label="Download presentation" title="Download presentation"><Download size={16} aria-hidden="true" /></a> : null}
    </div>
    <div className="workspace-presentation-preview-body">
      {!bytes || current?.error ? <div className="workspace-diff-code-empty" role="alert">{current?.error ?? "Presentation preview unavailable."}</div>
        : !current?.count ? <div className="workspace-diff-code-empty" role="status">Loading slides…</div> : null}
      <div className="workspace-presentation-slides" ref={hostRef} role="region" aria-label="Presentation slides" tabIndex={0} />
    </div>
  </div>;
}
