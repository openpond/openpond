import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizeBrowserUrl } from "../lib/browser-url";

const EMPTY_TABS: BrowserTabState[] = [];

export function useBrowserSidebar(conversationId: string) {
  const bridge = window.openpond?.browser;
  const [state, setState] = useState<BrowserConversationState>(() => ({
    conversationId,
    activeTabId: null,
    tabs: EMPTY_TABS,
  }));

  useEffect(() => {
    setState({ conversationId, activeTabId: null, tabs: EMPTY_TABS });
    if (!bridge) return undefined;
    let cancelled = false;
    void bridge.getState({ conversationId }).then((nextState) => {
      if (!cancelled) setState(nextState);
    });
    const unsubscribe = bridge.onState((nextState) => {
      if (nextState.conversationId === conversationId) setState(nextState);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, conversationId]);

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs],
  );

  const open = useCallback(
    async (rawUrl: string, options: { explicitFile?: boolean; newTab?: boolean } = {}) => {
      if (!bridge) return false;
      const url = normalizeBrowserUrl(rawUrl, { explicitFile: options.explicitFile });
      if (!url) return false;
      if (options.newTab) {
        await bridge.newTab({ conversationId, url, explicitFile: options.explicitFile });
      } else {
        await bridge.open({ conversationId, url, explicitFile: options.explicitFile });
      }
      return true;
    },
    [bridge, conversationId],
  );

  const activeTabInput = activeTab ? { conversationId, tabId: activeTab.id } : null;

  return {
    activeTab,
    available: Boolean(bridge),
    bridge,
    state,
    back: () => (bridge && activeTabInput ? bridge.back(activeTabInput) : Promise.resolve({ ok: false })),
    clearData: () => (bridge ? bridge.clearData({ conversationId }) : Promise.resolve({ ok: false })),
    closeTab: (tabId: string) => (bridge ? bridge.closeTab({ conversationId, tabId }) : Promise.resolve({ ok: false })),
    forward: () => (bridge && activeTabInput ? bridge.forward(activeTabInput) : Promise.resolve({ ok: false })),
    newTab: (url?: string) => (bridge ? bridge.newTab({ conversationId, url }) : Promise.resolve({ ok: false })),
    open,
    openExternal: () => (bridge && activeTabInput ? bridge.openExternal(activeTabInput) : Promise.resolve({ ok: false })),
    reload: () => (bridge && activeTabInput ? bridge.reload(activeTabInput) : Promise.resolve({ ok: false })),
    selectTab: (tabId: string) => (bridge ? bridge.selectTab({ conversationId, tabId }) : Promise.resolve({ ok: false })),
    setBounds: (bounds: BrowserBounds | null) =>
      bridge ? bridge.setBounds({ conversationId, bounds }) : Promise.resolve({ ok: false }),
    stop: () => (bridge && activeTabInput ? bridge.stop(activeTabInput) : Promise.resolve({ ok: false })),
  };
}
