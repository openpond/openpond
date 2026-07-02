import type { BrowserBounds, StoredBrowserConversation } from "./desktop-browser-types.js";

export function ensureStoredTab(
  conversation: StoredBrowserConversation,
  tabId: string,
  url: string,
): StoredBrowserConversation {
  const tab = conversation.tabs.find((item) => item.id === tabId);
  if (tab) {
    return {
      activeTabId: tabId,
      tabs: conversation.tabs.map((item) =>
        item.id === tabId ? { ...item, url, lastUpdatedAt: Date.now() } : item,
      ),
    };
  }
  return {
    activeTabId: tabId,
    tabs: [...conversation.tabs, { id: tabId, url, title: null, faviconUrl: null, lastUpdatedAt: Date.now() }],
  };
}

export function runtimeKey(conversationId: string, tabId: string | null): string {
  return `${conversationId}:${tabId ?? ""}`;
}

export function createTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeBounds(bounds: BrowserBounds | null): BrowserBounds | null {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
