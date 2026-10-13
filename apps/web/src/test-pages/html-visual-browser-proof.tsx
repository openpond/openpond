import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HtmlVisualReference } from "@openpond/contracts/html-visuals";
import { BrowserSidebar } from "../components/browser/BrowserSidebar";
import { HtmlVisual } from "../components/visuals/HtmlVisual";
import { OpenHtmlVisualContext } from "../components/visuals/html-visual-context";
import { useHtmlVisualTabs } from "../hooks/useHtmlVisualTabs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RightSidebarOverview } from "../components/app-shell/RightSidebarOverview";
import "../styles.css";
import "../styles/workspace-diff/workspace-diff-panel.css";

// Failure story: a native browser viewport can cover an HTML tab and swallow
// its clicks; switching tabs can also discard authored interactive state.
// Exercise the production components without an account or network requests.
const connection = { serverUrl: "https://visual-proof.invalid", token: "proof", platform: "web" };
const html = `<section style="padding:24px;background:var(--panel);border-radius:12px">
  <p style="color:var(--muted)">The Harness loop</p><h1>The model runs inside your Harness</h1>
  <p>A task comes in, the model works inside the Harness, and the result goes out.</p>
  <div style="display:flex;gap:12px;margin:32px 0">
    <div style="flex:1;padding:20px;border:1px solid var(--border);border-radius:8px">Task queued</div>
    <div style="flex:1;padding:20px;border:1px solid var(--border);border-radius:8px">Model + Harness</div>
    <div style="flex:1;padding:20px;border:1px solid var(--border);border-radius:8px">Output scored</div>
  </div>
  <button style="padding:10px 18px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text)" onclick="document.querySelector('output').textContent=Number(document.querySelector('output').textContent)+1">Run one turn</button>
  <p>Turns completed: <output>0</output></p>
</section><script>document.querySelector('section').dataset.instance=String(Math.random())</script>`;
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="360"><rect width="680" height="360" rx="12" fill="#f8fafc"/><g font-family="sans-serif" fill="#15313e"><text x="24" y="58" font-size="25" font-weight="bold">The model runs inside your Harness</text><text x="24" y="90" font-size="14">Task → Model + Harness → Output</text><rect x="24" y="125" width="632" height="150" rx="8" fill="#ebefff"/><text x="220" y="212" font-size="24">Model + Harness</text><text x="24" y="325" font-size="14">Click to open the interactive page</text></g></svg>`;
const visual = (suffix: string, title: string): HtmlVisualReference => ({
  visualId: `visual_${suffix.repeat(32)}`, publicationId: `visual_pub_${suffix.repeat(32)}`,
  sessionId: "visual-proof", turnId: "proof-turn", heights: [{ width: 680, height: 360 }],
  output: { kind: "file", id: `proof-${suffix}`, title, sourceTaskId: "visual-proof", sourceTurnId: "proof-turn",
    revision: 1, createdAt: "2026-10-13T15:00:00Z", contentType: "text/html", sizeBytes: html.length,
    sha256: "0".repeat(64), location: { kind: "managed", fileId: `proof-${suffix}`, downloadPath: "/proof" }, validation: [] },
});
const visuals = [visual("a", "Harness loop"), visual("b", "Another visual")];
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(connection.serverUrl)) return originalFetch(input, init);
  if (url.endsWith("/visuals")) return Response.json({ visuals });
  if (url.endsWith("/files")) return Response.json({ files: [] });
  if (url.endsWith("/document")) return Response.json({ html });
  if (url.endsWith("/preview")) return new Response(preview, { headers: { "Content-Type": "image/svg+xml" } });
  return new Response(null, { status: 404 });
};

let nativeState: BrowserConversationState = { conversationId: "visual-proof", activeTabId: "native", tabs: [{
  id: "native", url: "https://example.com/", title: "Existing browser tab", faviconUrl: null,
  loading: false, canGoBack: false, canGoForward: false, error: null,
}] };
const listeners = new Set<(state: BrowserConversationState) => void>();
const reveals = new Set<(request: BrowserRevealRequest) => void>();
const update = () => { listeners.forEach(listener => listener(nativeState)); return Promise.resolve({ ok: true }); };
const browserBridge: Partial<NonNullable<Window["openpond"]>["browser"]> = {
  captureHtml: async capture => {
    const canvas = document.createElement("canvas"); canvas.width = capture.rect.width; canvas.height = capture.rect.height;
    const context = canvas.getContext("2d")!; context.fillStyle = getComputedStyle(document.querySelector(".app-shell")!).getPropertyValue("--surface-panel"); context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = getComputedStyle(document.querySelector(".app-shell")!).getPropertyValue("--text-primary"); context.font = "20px sans-serif"; context.fillText(capture.selector, 24, 40);
    return { ok: true, image: { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, selector: capture.selector, source: capture.source } };
  },
  getState: async () => nativeState,
  onState: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  onRevealRequest: callback => { reveals.add(callback); return () => { reveals.delete(callback); }; },
  setBounds: async () => ({ ok: true }),
  selectTab: async ({ tabId }) => { nativeState = { ...nativeState, activeTabId: tabId }; return update(); },
  closeTab: async ({ tabId }) => { nativeState = { ...nativeState, tabs: nativeState.tabs.filter(tab => tab.id !== tabId) }; return update(); },
  newTab: async () => { nativeState = { ...nativeState, activeTabId: "new", tabs: [...nativeState.tabs, { ...nativeState.tabs[0]!, id: "new", title: "New tab", url: "about:blank" }] }; return update(); },
  reload: async () => ({ ok: true }),
};
window.openpond = { browser: browserBridge as NonNullable<Window["openpond"]>["browser"] } as Window["openpond"];

function Proof() {
  const [conversationId, setConversationId] = useState("visual-proof");
  const tabs = useHtmlVisualTabs(conversationId);
  return <div className="app-shell" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(420px, 1fr)", height: "100vh" }}>
    <div style={{ padding: 24, overflow: "auto" }}>
      <h2>HTML visual browser proof</h2>
      <p>Click a preview or Expand. Run a turn in the page, switch tabs, and return. The count should remain. Reload should reset it.</p>
      <button onClick={() => reveals.forEach(callback => callback({ conversationId, reason: "model_tool" }))}>Reveal native browser</button>
      <button onClick={() => setConversationId(id => id === "visual-proof" ? "another-conversation" : "visual-proof")}>Switch conversation</button>
      <OpenHtmlVisualContext.Provider value={tabs.open}>
        <RightSidebarOverview messages={[]} events={[]} actions={null} onOpenFile={() => {}} connection={connection} workspaceId={null} sessionId={conversationId} conversationId={conversationId} onOpenBrowser={tabs.showBrowser} />
        {visuals.map(item => <div key={item.publicationId} style={{ marginTop: 24 }}><HtmlVisual visual={item} connection={connection} /></div>)}
      </OpenHtmlVisualContext.Provider>
    </div>
    <BrowserSidebar conversationId={conversationId} connection={connection} visualTabs={tabs} expanded={false} onResizeStart={() => {}} />
  </div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><QueryClientProvider client={new QueryClient()}><Proof /></QueryClientProvider></StrictMode>);
import.meta.hot?.dispose(() => { root.unmount(); window.fetch = originalFetch; });
