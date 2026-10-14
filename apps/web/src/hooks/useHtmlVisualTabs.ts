import { useCallback, useEffect, useState } from "react";
import type { HtmlVisualReference } from "@openpond/contracts/html-visuals";

export function useHtmlVisualTabs(conversationId: string) {
  const [state, setState] = useState<{ tabs: HtmlVisualReference[]; activeId: string | null }>({ tabs: [], activeId: null });

  useEffect(() => {
    setState({ tabs: [], activeId: null });
  }, [conversationId]);

  useEffect(() => window.openpond?.browser?.onRevealRequest?.(request => {
    if (request.conversationId === conversationId) {
      setState(current => ({ ...current, activeId: null }));
    }
  }), [conversationId]);

  const open = useCallback((visual: HtmlVisualReference) => {
    setState(current => ({
      tabs: current.tabs.some(tab => tab.publicationId === visual.publicationId)
        ? current.tabs : [...current.tabs, visual],
      activeId: visual.publicationId,
    }));
  }, []);
  const close = useCallback((id: string) => {
    setState(current => {
      const index = current.tabs.findIndex(tab => tab.publicationId === id);
      const tabs = current.tabs.filter(tab => tab.publicationId !== id);
      return { tabs, activeId: current.activeId === id
        ? tabs[Math.min(index, tabs.length - 1)]?.publicationId ?? null : current.activeId };
    });
  }, []);
  const select = useCallback((activeId: string | null) => setState(current => ({ ...current, activeId })), []);
  const showBrowser = useCallback(() => select(null), [select]);

  return { ...state, open, close, select, showBrowser };
}
