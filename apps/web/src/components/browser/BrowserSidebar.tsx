import { ErrorToast } from "../common/ErrorToast";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef, useState } from "react";
import "../../styles/browser/browser-sidebar.css";
import { Globe2 } from "../icons";
import { useBrowserSidebar } from "../../hooks/useBrowserSidebar";
import { BrowserTabs } from "./BrowserTabs";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserViewport } from "./BrowserViewport";
import type { ClientConnection } from "../../api";
import type { useHtmlVisualTabs } from "../../hooks/useHtmlVisualTabs";
import { HtmlVisual } from "../visuals/HtmlVisual";
import type { HtmlVisualSnapshotHandle } from "../visuals/useHtmlVisualSnapshot";
import { BrowserSnapshotMenu } from "./BrowserSnapshotMenu";
import { BrowserSnapshotPreview } from "./BrowserSnapshotPreview";
import { useBrowserCapture } from "./useBrowserCapture";
import { useAppToast } from "../../app/AppToastContext";

export function BrowserSidebar({
  conversationId,
  expanded,
  onResizeStart,
  connection = null,
  visualTabs,
}: {
  conversationId: string;
  expanded: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  connection?: ClientConnection | null;
  visualTabs?: ReturnType<typeof useHtmlVisualTabs>;
}) {
  const browser = useBrowserSidebar(conversationId);
  const toast = useAppToast();
  const [reloadVersions, setReloadVersions] = useState<Record<string, number>>({});
  const activeVisual = visualTabs?.tabs.find((tab) => tab.publicationId === visualTabs.activeId);
  const visualSnapshot = useRef<HtmlVisualSnapshotHandle | null>(null);
  const snapshot = useBrowserCapture(
    conversationId,
    browser.activeTab?.id ?? null,
    activeVisual?.publicationId ?? null,
    visualSnapshot,
  );
  const documentTabs: BrowserTabState[] = (visualTabs?.tabs ?? []).map((visual) => ({
    id: visual.publicationId,
    url: `${visual.output.title}.html`,
    title: visual.output.title,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  }));
  const activeDocumentTab = documentTabs.find((tab) => tab.id === activeVisual?.publicationId);
  const setBounds = useCallback(
    (bounds: BrowserBounds | null) => {
      void window.openpond?.browser?.setBounds({ conversationId, bounds });
    },
    [conversationId],
  );

  const navigate = useCallback(
    (url: string) => {
      visualTabs?.showBrowser();
      void browser.open(url, { explicitFile: true }).catch((error) =>
        toast?.(error instanceof Error ? error.message : "Could not open browser.", "error"));
    },
    [browser, visualTabs, toast],
  );

  const clearData = useCallback(() => {
    if (
      !window.confirm(
        "Clear shared browser data? Cookies, logins, cache, and site storage will be removed for all chats. This chat's browser tabs will also close.",
      )
    ) {
      return;
    }
    void browser.clearData();
  }, [browser]);

  return (
    <aside
      className={`workspace-diff-panel browser-sidebar-panel ${expanded ? "expanded" : ""} ${snapshot.busy === "node" || snapshot.error ? "has-capture-status" : ""}`}
      aria-label="Browser"
    >
      {!expanded && (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize browser panel"
          onPointerDown={onResizeStart}
        />
      )}
      <BrowserTabs
        activeTabId={activeVisual?.publicationId ?? browser.state.activeTabId}
        tabs={[...browser.state.tabs, ...documentTabs]}
        onCloseTab={(tabId) => {
          if (documentTabs.some((tab) => tab.id === tabId)) visualTabs?.close(tabId);
          else void browser.closeTab(tabId);
        }}
        onNewTab={() => {
          visualTabs?.showBrowser();
          void browser.newTab();
        }}
        onSelectTab={(tabId) => {
          if (documentTabs.some((tab) => tab.id === tabId)) visualTabs?.select(tabId);
          else {
            visualTabs?.showBrowser();
            void browser.selectTab(tabId);
          }
        }}
      />
      <BrowserToolbar
        activeTab={activeDocumentTab ?? browser.activeTab}
        documentName={activeDocumentTab?.url}
        available={browser.available}
        snapshotActions={
          <BrowserSnapshotMenu
            available={
              !snapshot.image &&
              Boolean(
                activeVisual
                  ? window.openpond?.browser?.captureHtml
                  : browser.activeTab &&
                      !browser.activeTab.loading &&
                      window.openpond?.browser?.capturePage,
              )
            }
            busy={Boolean(snapshot.busy)}
            onCapture={(mode) => void snapshot.capture(mode)}
            onCancel={snapshot.cancel}
          />
        }
        onBack={() => void browser.back()}
        onClearData={clearData}
        onForward={() => void browser.forward()}
        onNavigate={navigate}
        onOpenExternal={() => void browser.openExternal()}
        onReload={() => {
          if (activeVisual)
            setReloadVersions((current) => ({
              ...current,
              [activeVisual.publicationId]: (current[activeVisual.publicationId] ?? 0) + 1,
            }));
          else void browser.reload();
        }}
        onStop={() => void browser.stop()}
      />
      {snapshot.busy === "node" ? (
        <p className="browser-snapshot-status" role="status">
          Hover to highlight an element, then click to capture it. Press Esc to cancel.
        </p>
      ) : null}
      {snapshot.error ? (
        <ErrorToast error={snapshot.error} />
      ) : null}
      <div className="browser-content">
        {snapshot.image ? (
          <BrowserSnapshotPreview image={snapshot.image} onClose={snapshot.close} />
        ) : null}
        {visualTabs?.tabs.map((visual) => (
          <div
            key={visual.publicationId}
            className="browser-visual-document"
            role="tabpanel"
            aria-label={visual.output.title}
            hidden={Boolean(snapshot.image) || visual.publicationId !== activeVisual?.publicationId}
          >
            <HtmlVisual
              key={reloadVersions[visual.publicationId] ?? 0}
              visual={visual}
              connection={connection}
              expanded
              snapshotRef={
                visual.publicationId === activeVisual?.publicationId ? visualSnapshot : undefined
              }
            />
          </div>
        ))}
        {!activeVisual && !browser.available ? (
          <div className="browser-empty-state">
            <Globe2 size={18} />
            <span>Desktop browser bridge unavailable.</span>
          </div>
        ) : !activeVisual && browser.state.tabs.length === 0 ? (
          <div className="browser-empty-state">
            <Globe2 size={18} />
            <span>Enter a URL to open a browser tab for this conversation.</span>
          </div>
        ) : null}
        <BrowserViewport
          active={
            !snapshot.image && !activeVisual && browser.available && browser.state.tabs.length > 0
          }
          onBounds={setBounds}
        />
      </div>
    </aside>
  );
}
