import { Globe2, Plus, X } from "../icons";

export function BrowserTabs({
  activeTabId,
  tabs,
  onCloseTab,
  onNewTab,
  onSelectTab,
}: {
  activeTabId: string | null;
  tabs: BrowserTabState[];
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onSelectTab: (tabId: string) => void;
}) {
  return (
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {tabs.map((tab) => (
        <div className={`browser-tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
          <span className="browser-tab-favicon" aria-hidden="true">
            {tab.faviconUrl ? (
              <img alt="" referrerPolicy="no-referrer" src={tab.faviconUrl} />
            ) : (
              <Globe2 size={13} />
            )}
          </span>
          <button
            type="button"
            className="browser-tab-main"
            role="tab"
            aria-selected={tab.id === activeTabId}
            title={tab.url}
            onClick={() => onSelectTab(tab.id)}
          >
            {browserTabLabel(tab)}
          </button>
          <button
            type="button"
            className="browser-tab-close"
            title="Close tab"
            aria-label="Close tab"
            onClick={() => onCloseTab(tab.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="browser-tab-add" title="New tab" aria-label="New tab" onClick={onNewTab}>
        <Plus size={14} />
      </button>
    </div>
  );
}

function browserTabLabel(tab: BrowserTabState): string {
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "New tab";
  }
}
