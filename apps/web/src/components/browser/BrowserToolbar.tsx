import { ArrowLeft, ArrowRight, ExternalLink, MoreHorizontal, RefreshCw, Square } from "../icons";
import { useEffect, useState, type FormEvent } from "react";

export function BrowserToolbar({
  activeTab,
  available,
  onBack,
  onClearData,
  onForward,
  onNavigate,
  onOpenExternal,
  onReload,
  onStop,
}: {
  activeTab: BrowserTabState | null;
  available: boolean;
  onBack: () => void;
  onClearData: () => void;
  onForward: () => void;
  onNavigate: (url: string) => void;
  onOpenExternal: () => void;
  onReload: () => void;
  onStop: () => void;
}) {
  const [draftUrl, setDraftUrl] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setDraftUrl(activeTab?.url ?? "");
  }, [activeTab?.url]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onNavigate(draftUrl);
  }

  return (
    <div className="browser-toolbar">
      <div className="browser-nav-actions">
        <button type="button" title="Back" aria-label="Back" disabled={!activeTab?.canGoBack} onClick={onBack}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" title="Forward" aria-label="Forward" disabled={!activeTab?.canGoForward} onClick={onForward}>
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          title={activeTab?.loading ? "Stop" : "Reload"}
          aria-label={activeTab?.loading ? "Stop" : "Reload"}
          disabled={!activeTab}
          onClick={activeTab?.loading ? onStop : onReload}
        >
          {activeTab?.loading ? <Square size={13} /> : <RefreshCw size={14} />}
        </button>
      </div>
      <form className="browser-address-form" onSubmit={submit}>
        <input
          aria-label="Browser address"
          disabled={!available}
          placeholder={available ? "Search or enter address" : "Desktop browser unavailable"}
          spellCheck={false}
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
        />
      </form>
      <div className="browser-panel-actions">
        <button type="button" title="Open external" aria-label="Open external" disabled={!activeTab} onClick={onOpenExternal}>
          <ExternalLink size={14} />
        </button>
        <div className="browser-menu-anchor">
          <button
            type="button"
            title="Browser actions"
            aria-label="Browser actions"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <div className="browser-options-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onClearData();
                }}
              >
                Clear Browser Data...
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
