import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserSidebar } from "../components/browser/BrowserSidebar";
import { useLayoutPreferences } from "../hooks/useLayoutPreferences";
import "../styles.css";

// Failure story: the native browser sits above every DOM z-index and can cover
// the divider below its header. Model that boundary with a top-level iframe,
// and exercise the real sidebar, bounds reporting, and resize gesture.
const nativeSurface = document.createElement("iframe");
nativeSurface.title = "Native browser surface simulation";
nativeSurface.style.cssText = "position:fixed;z-index:2147483647;border:0;";
nativeSurface.hidden = true;
const theme = getComputedStyle(document.documentElement);
nativeSurface.srcdoc = `<body style="margin:0;padding:32px;font:14px system-ui;background:${theme.getPropertyValue("--surface-page")};color:${theme.getPropertyValue("--text-primary")}"><h2>Browser content</h2><p>This surface receives its own pointer events and sits above the app.</p><p>Drag the divider at the middle or bottom, in either direction.</p></body>`;
document.body.append(nativeSurface);
const state: BrowserConversationState = {
  conversationId: "resize-proof", activeTabId: "native", tabs: [{
    id: "native", url: "https://example.com/", title: "Browser content", faviconUrl: null,
    loading: false, canGoBack: false, canGoForward: false, error: null,
  }],
};
const browserBridge: Partial<NonNullable<Window["openpond"]>["browser"]> = {
  getState: async () => state,
  onState: () => () => {},
  setBounds: async ({ bounds }) => {
    nativeSurface.hidden = !bounds;
    if (bounds) Object.assign(nativeSurface.style, {
      left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
    });
    return { ok: true };
  },
};
window.openpond = { browser: browserBridge as NonNullable<Window["openpond"]>["browser"] } as Window["openpond"];
const ignore = () => {};
function Proof() {
  const [expanded, setExpanded] = useState(false);
  const layout = useLayoutPreferences({
    connection: null, preferences: undefined, sidebarOpen: false, diffPanelExpanded: expanded,
    setBootstrap: ignore, setError: ignore,
  });
  return <div className={`app-shell ${layout.diffPanelResizing ? "diff-panel-resizing" : ""}`}
    style={{ height: "100vh", gridTemplateColumns: `minmax(0, 1fr) ${layout.diffPanelWidth}px` }}>
    <main style={{ padding: 24 }}>
      <h1>Browser divider</h1>
      <p>Resize from anywhere along the divider, including beside the browser content.</p>
      <output aria-label="Panel width">{layout.diffPanelWidth}px</output>
      <p><button onClick={() => setExpanded(value => !value)}>{expanded ? "Show resize divider" : "Hide resize divider"}</button></p>
    </main>
    <BrowserSidebar conversationId="resize-proof" expanded={expanded} onResizeStart={layout.startDiffPanelResize} />
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><Proof /></StrictMode>);
import.meta.hot?.dispose(() => { root.unmount(); nativeSurface.remove(); });
