import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { htmlVisualDocument } from "@openpond/contracts/html-visual-document";
import { HTML_VISUAL_MAX_HEIGHT, HTML_VISUAL_THEME, type HtmlVisualReference, type HtmlVisualTheme } from "@openpond/contracts/html-visuals";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import "./html-visual.css";

import { OpenHtmlVisualContext } from "./html-visual-context";
function theme(): HtmlVisualTheme {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(HTML_VISUAL_THEME).map(([key, fallback]) => [key, styles.getPropertyValue(key).trim() || fallback])) as HtmlVisualTheme;
}

// Only published references reach this renderer. No tool argument or Markdown
// content is treated as a visual. Both preview and display use the same wrapper.
export function HtmlVisual({ visual, connection, expanded = false }: {
  visual: HtmlVisualReference; connection: ClientConnection | null; expanded?: boolean;
}) {
  const open = useContext(OpenHtmlVisualContext);
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(expanded);
  const [visited, setVisited] = useState(expanded);
  const [source, setSource] = useState(false);
  const [height, setHeight] = useState(visual.heights[0]?.height ?? 320);
  const identity = `${visual.publicationId}:${expanded ? "expanded" : "inline"}:${retry}`;
  const path = `/v1/sessions/${encodeURIComponent(visual.sessionId)}/visuals/${visual.publicationId}`;
  useEffect(() => {
    const element = container.current;
    if (!element || expanded) return;
    const observer = new IntersectionObserver(([entry]) => {
      // Keep a focused document alive while interacting with its controls.
      const active = Boolean(entry?.isIntersecting) || document.activeElement === frame.current;
      setVisible(active);
      if (active) setVisited(true);
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  useEffect(() => {
    if (!connection || !visited) return;
    const controller = new AbortController();
    let previewUrl: string | null = null;
    setHtml(null); setError(null); setPreview(null);
    void Promise.all([
      apiFetch<{ html: string }>(connection, `${path}/document`, { signal: controller.signal }),
      fetch(`${connection.serverUrl}${path}/preview`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: controller.signal })
        .then(response => { if (!response.ok) throw new Error("Preview unavailable"); return response.blob(); }),
    ]).then(([document, png]) => {
      if (controller.signal.aborted) return;
      setHtml(document.html); previewUrl = URL.createObjectURL(png); setPreview(previewUrl);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Visual unavailable"); });
    return () => { controller.abort(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [connection, path, retry, visited]);
  const documentSource = useMemo(() => html === null ? undefined : htmlVisualDocument(html, identity, theme()), [html, identity]);
  useEffect(() => {
    if (!documentSource || !(visible || expanded) || source) return;
    const timeout = setTimeout(() => setError("The visual did not finish loading."), 8000);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || data?.identity !== identity) return;
      if (data.type === "openpond-visual-interaction") {
        container.current?.dispatchEvent(new Event("openpond-visual-interaction", { bubbles: true }));
        return;
      }
      if (data.type !== "openpond-visual-size" || !Number.isFinite(data.height)) return;
      clearTimeout(timeout);
      setHeight(Math.max(80, Math.min(HTML_VISUAL_MAX_HEIGHT, Math.ceil(data.height))));
    };
    const sendTheme = () => frame.current?.contentWindow?.postMessage({ type: "openpond-theme", identity, theme: theme() }, "*");
    window.addEventListener("message", receive);
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    appearance.addEventListener("change", sendTheme);
    return () => { clearTimeout(timeout); observer.disconnect(); window.removeEventListener("message", receive); appearance.removeEventListener("change", sendTheme); };
  }, [identity, documentSource, expanded, source, visible]);
  const download = () => {
    if (html === null) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${visual.output.title}.html`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="html-visual" ref={container} data-visual-id={visual.visualId} data-publication-id={visual.publicationId}>
    <div className="html-visual-toolbar">
      <span>{visual.output.title}{visual.output.revision > 1 ? ` · Revision ${visual.output.revision}` : ""}</span>
      <button type="button" disabled={html === null} onClick={() => setSource(value => !value)} aria-pressed={source}>{source ? "Visual" : "Source"}</button>
      <button type="button" disabled={html === null} onClick={download}>Download</button>
      {!expanded && open ? <button type="button" onClick={() => open(visual)}>Expand</button> : null}
    </div>
    {!connection ? <p className="html-visual-status">Connect to view this visual.</p> : error ? <p className="html-visual-status" role="status">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : source ? <pre className="html-visual-source" tabIndex={0}>{html}</pre> :
      <div className="html-visual-content" style={{ minHeight: height }}>
        {documentSource && (visible || expanded) ? <iframe ref={frame} title={visual.output.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          srcDoc={documentSource} style={{ height }} /> : preview ? <button className="html-visual-preview" type="button" onClick={() => setVisible(true)} aria-label={`Activate ${visual.output.title}`}><img src={preview} alt={`Saved preview of ${visual.output.title}`} style={{ maxHeight: height }} /></button> : <p className="html-visual-status" role="status">Loading visual…</p>}
      </div>}
    {height === HTML_VISUAL_MAX_HEIGHT && !source ? <p className="html-visual-status">This visual reaches the height limit. Scroll inside it to see more.</p> : null}
  </div>;
}
