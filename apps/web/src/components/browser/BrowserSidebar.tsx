import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback } from "react";
import "../../styles/browser/browser-sidebar.css";
import { Globe2 } from "../icons";
import { useBrowserSidebar } from "../../hooks/useBrowserSidebar";
import { BrowserTabs } from "./BrowserTabs";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserViewport } from "./BrowserViewport";

export function BrowserSidebar({
  conversationId,
  expanded,
  onResizeStart,
}: {
  conversationId: string;
  expanded: boolean;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const browser = useBrowserSidebar(conversationId);
  const setBounds = useCallback((bounds: BrowserBounds | null) => {
    void window.openpond?.browser?.setBounds({ conversationId, bounds });
  }, [conversationId]);

  const navigate = useCallback((url: string) => {
    void browser.open(url, { explicitFile: true });
  }, [browser]);

  const clearData = useCallback(() => {
    if (!window.confirm("Clear browser data for this conversation? Tabs, cookies, cache, and local storage for this conversation will be removed.")) {
      return;
    }
    void browser.clearData();
  }, [browser]);

  return (
    <aside className={`workspace-diff-panel browser-sidebar-panel ${expanded ? "expanded" : ""}`} aria-label="Browser">
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
        activeTabId={browser.state.activeTabId}
        tabs={browser.state.tabs}
        onCloseTab={(tabId) => void browser.closeTab(tabId)}
        onNewTab={() => void browser.newTab()}
        onSelectTab={(tabId) => void browser.selectTab(tabId)}
      />
      <BrowserToolbar
        activeTab={browser.activeTab}
        available={browser.available}
        onBack={() => void browser.back()}
        onClearData={clearData}
        onForward={() => void browser.forward()}
        onNavigate={navigate}
        onOpenExternal={() => void browser.openExternal()}
        onReload={() => void browser.reload()}
        onStop={() => void browser.stop()}
      />
      <div className="browser-content">
        {!browser.available ? (
          <div className="browser-empty-state">
            <Globe2 size={18} />
            <span>Desktop browser bridge unavailable.</span>
          </div>
        ) : browser.state.tabs.length === 0 ? (
          <div className="browser-empty-state">
            <Globe2 size={18} />
            <span>Enter a URL to open a browser tab for this conversation.</span>
          </div>
        ) : null}
        <BrowserViewport active={browser.available && browser.state.tabs.length > 0} onBounds={setBounds} />
      </div>
    </aside>
  );
}
