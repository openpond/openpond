import { inlineErrorMessage } from "../../lib/error-messages";
import { useContext, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { htmlVisualDocument } from "@openpond/contracts/html-visual-document";
import { HTML_VISUAL_MAX_HEIGHT, HTML_VISUAL_THEME, HTML_VISUAL_THEME_TOKENS, HtmlVisualResourceSelectionSchema, type HtmlVisualReference, type HtmlVisualTheme, type HtmlVisualResourceSelection } from "@openpond/contracts/html-visuals";
import type { ChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { apiFetch, fetchApiResponse, type ClientConnection } from "../../api/api-client";
import { Download, Maximize2 } from "../icons";
import { useHtmlVisualSnapshot, type HtmlVisualSnapshotHandle } from "./useHtmlVisualSnapshot";
import "./html-visual.css";

import { OpenHtmlVisualContext, SelectHtmlResourceContext } from "./html-visual-context";
function theme(): HtmlVisualTheme {
  const styles = getComputedStyle(document.querySelector(".app-shell") ?? document.documentElement);
  return Object.fromEntries(Object.entries(HTML_VISUAL_THEME).map(([key, fallback]) => [key, key === "--color-scheme" ? document.documentElement.dataset.theme ?? "dark" : styles.getPropertyValue(HTML_VISUAL_THEME_TOKENS[key as keyof typeof HTML_VISUAL_THEME_TOKENS] ?? key).trim() || fallback])) as HtmlVisualTheme;
}

// Only published references reach this renderer. No tool argument or Markdown
// content is treated as a visual. Both preview and display use the same wrapper.
export function HtmlVisual({ visual, connection, expanded = false, snapshotRef }: {
  visual: HtmlVisualReference; connection: ClientConnection | null; expanded?: boolean;
  snapshotRef?: Ref<HtmlVisualSnapshotHandle>;
}) {
  const open = useContext(OpenHtmlVisualContext);
  const selectResource = useContext(SelectHtmlResourceContext);
  const selecting = useRef(false);
  const chooseRef = useRef<((resource:HtmlVisualResourceSelection)=>Promise<void>)|null>(null);
  const operation = useRef<{key:string;id:string}|null>(null);
  const [selectionBusy,setSelectionBusy] = useState(false);
  const [selectionError,setSelectionError] = useState<string|null>(null);
  const [receipt,setReceipt] = useState<string|null>(null);
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [visited, setVisited] = useState(expanded);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(visual.heights[0]?.height ?? 320);
  const identity = `${visual.publicationId}:${expanded ? "expanded" : "inline"}:${retry}`;
  const receiveSnapshot = useHtmlVisualSnapshot(frame, identity, ready, snapshotRef);
  const path = `/v1/sessions/${encodeURIComponent(visual.sessionId)}/visuals/${visual.publicationId}`;
  const serverUrl = connection?.serverUrl;
  const token = connection?.token;
  const platform = connection?.platform;
  const clickablePreview = !expanded && Boolean(open);
  useEffect(() => {
    const element = container.current;
    if (!element || visited || expanded) return;
    const observer = new IntersectionObserver(([entry]) => {
      // Lazy-load once, then retain the document and its interactive state even
      // when scrolling or resizing temporarily moves it outside the viewport.
      if (entry?.isIntersecting) setVisited(true);
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, visited]);
  useEffect(() => {
    if (!serverUrl || !token || !(visited || expanded)) return;
    const controller = new AbortController();
    let previewUrl: string | null = null;
    setHtml(null); setError(null); setPreview(null);
    void Promise.all([
      apiFetch<{ html: string }>({ serverUrl, token, platform: platform ?? "web" }, `${path}/document`, { signal: controller.signal }),
      fetchApiResponse({ serverUrl, token }, `${path}/preview`, { signal: controller.signal })
        .then(response => { if (!response.ok) throw new Error("Preview unavailable"); return response.blob(); }),
    ]).then(([document, png]) => {
      if (controller.signal.aborted) return;
      setHtml(document.html); previewUrl = URL.createObjectURL(png); setPreview(previewUrl);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Visual unavailable"); });
    return () => { controller.abort(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [serverUrl, token, platform, path, retry, visited, expanded]);
  useEffect(()=>{
    if(!connection || !(visited || expanded) || !html?.includes("data-openpond-resource-id"))return;
    const controller=new AbortController();
    void chatResourceRequest<{focus:ChatResourceFocus}>(connection,"dataset",{action:"context",payload:{sessionId:visual.sessionId}},controller.signal).then(context=>{
      const saved=Object.entries(context.focus.scopeContext?.selectionOperations ?? {}).filter(([,value])=>value.visualPublicationId===visual.publicationId && value.resource)
        .sort((a,b)=>b[1].version-a[1].version)[0];
      if(!controller.signal.aborted && saved && !selecting.current){const resource=saved[1].resource!;operation.current={key:`${resource.kind}:${resource.id}:${resource.revision}`,id:saved[0]};setReceipt(`Selected ${resource.kind}: ${resource.name}${resource.kind==='dataset' ? ` V${resource.revision}` : ''}.`);}
    }).catch(()=>{});
    return ()=>controller.abort();
  },[connection,visual.sessionId,visual.publicationId,visited,expanded,html]);
  async function choose(resource:HtmlVisualResourceSelection) {
    if(!selectResource || selecting.current)return;
    selecting.current=true;setSelectionBusy(true);setSelectionError(null);
    const key=`${resource.kind}:${resource.id}:${resource.revision}`;
    if(operation.current?.key!==key)operation.current={key,id:`visual-select-${crypto.randomUUID()}`};
    try {setReceipt(await selectResource(visual,resource,operation.current.id));}
    catch(cause){setSelectionError(cause instanceof Error ? cause.message : "Resource selection failed.");}
    finally{selecting.current=false;setSelectionBusy(false);}
  }
  chooseRef.current=choose;
  const documentSource = useMemo(() => html === null || clickablePreview ? undefined : htmlVisualDocument(html, identity, theme()), [html, identity, clickablePreview]);
  useEffect(() => {
    setReady(false);
    if (!documentSource) return;
    const timeout = setTimeout(() => setError("The visual did not finish loading."), 8000);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || data?.identity !== identity) return;
      if (data.type === "openpond-visual-snapshot") { receiveSnapshot(data); return; }
      if(data.type === "openpond-visual-resource-select") {
        const resource=HtmlVisualResourceSelectionSchema.safeParse(data.resource);
        if(resource.success)void chooseRef.current?.(resource.data);
        return;
      }
      if (data.type === "openpond-visual-interaction") {
        container.current?.dispatchEvent(new Event("openpond-visual-interaction", { bubbles: true }));
        return;
      }
      if (data.type !== "openpond-visual-size" || !Number.isFinite(data.height)) return;
      if (data.ready === true) { clearTimeout(timeout); setReady(true); }
      setHeight(Math.max(80, Math.min(HTML_VISUAL_MAX_HEIGHT, Math.ceil(data.height))));
    };
    const sendTheme = () => frame.current?.contentWindow?.postMessage({ type: "openpond-theme", identity, theme: theme() }, "*");
    window.addEventListener("message", receive);
    const observer = new MutationObserver(sendTheme);
    const themeRoots = [document.documentElement, document.querySelector(".app-shell")].filter((element): element is Element => element !== null);
    for (const element of themeRoots) observer.observe(element, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    appearance.addEventListener("change", sendTheme);
    return () => { clearTimeout(timeout); observer.disconnect(); window.removeEventListener("message", receive); appearance.removeEventListener("change", sendTheme); };
  }, [identity, documentSource, receiveSnapshot]);
  const download = () => {
    if (html === null) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${visual.output.title}.html`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="html-visual" ref={container} data-visual-id={visual.visualId} data-publication-id={visual.publicationId}>
    <div className="html-visual-toolbar">
      <span>{visual.output.title}{visual.output.revision > 1 ? ` · Revision ${visual.output.revision}` : ""}</span>
      <button type="button" disabled={html === null} onClick={download} title="Download HTML" aria-label="Download HTML"><Download size={15} aria-hidden /></button>
      {!expanded && open ? <button type="button" onClick={() => open(visual)} title="Open in browser panel" aria-label="Expand visual"><Maximize2 size={15} aria-hidden /></button> : null}
    </div>
    {receipt ? <div className="html-visual-selection-receipt"><span>{receipt}</span><button type="button" onClick={()=>{setReceipt(null);setSelectionError(null);operation.current=null;}}>Change</button></div> : null}
    {selectionBusy ? <p role="status" className="html-visual-status">Selecting resource…</p> : null}
    {selectionError && inlineErrorMessage(selectionError) ? <p role="status" className="html-visual-status">{selectionError} Select the resource again to retry.</p> : null}
      <div className="html-visual-content" style={clickablePreview ? undefined : { minHeight: height }} hidden={receipt!==null}>
        {!connection ? <p className="html-visual-status">Connect to view this visual.</p> : error && inlineErrorMessage(error) ? <p className="html-visual-status" role="status">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : <>
          {clickablePreview ? <button type="button" className="html-visual-preview" onClick={() => open?.(visual)} aria-label={`Open ${visual.output.title} in browser panel`}>
            {preview ? <img src={preview} alt={`Preview of ${visual.output.title}`} /> : <span className="html-visual-status">Loading visual…</span>}
          </button> : <>
          {documentSource ? <iframe ref={frame} title={visual.output.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            srcDoc={documentSource} style={{ height, opacity: ready ? 1 : 0 }} /> : null}
          {!ready ? <div className="html-visual-placeholder">
            {preview ? <img src={preview} alt={`Saved preview of ${visual.output.title}`} style={{ maxHeight: height }} /> : <p className="html-visual-status" role="status">Loading visual…</p>}
          </div> : null}
          </>}
        </>}
      </div>
    {height === HTML_VISUAL_MAX_HEIGHT && !clickablePreview ? <p className="html-visual-status">This visual reaches the height limit. Scroll inside it to see more.</p> : null}
  </div>;
}
