import { getLocalRecord, putLocalRecord, deleteLocalRecord } from "@openpond/persistence";
import type { StoredBrowserConversation, StoredBrowserTab } from "./desktop-browser-types.js";

export class BrowserSidebarStore {
  constructor(private readonly home: string) {}
  async conversation(conversationId: string): Promise<StoredBrowserConversation> {
    return cloneConversation(getLocalRecord<StoredBrowserConversation>(this.home, "browser_tab_state", conversationId)?.value);
  }
  // Keep read/modify/write in one synchronous turn so concurrent tab commands
  // cannot replace each other's conversation snapshots across an await.
  async mutateConversation(conversationId: string, update: (current: StoredBrowserConversation) => StoredBrowserConversation): Promise<StoredBrowserConversation> {
    const saved = getLocalRecord<StoredBrowserConversation>(this.home, "browser_tab_state", conversationId);
    const next = cloneConversation(update(cloneConversation(saved?.value)));
    putLocalRecord(this.home, "browser_tab_state", conversationId, next, saved?.revision ?? null);
    return next;
  }
  async updateTab(conversationId: string, tabId: string, patch: Partial<Omit<StoredBrowserTab, "id">>): Promise<StoredBrowserConversation> {
    const saved = getLocalRecord<StoredBrowserConversation>(this.home, "browser_tab_state", conversationId);
    const conversation = cloneConversation(saved?.value);
    if (!conversation.tabs.some((tab) => tab.id === tabId)) return conversation;
    const next = { ...conversation, tabs: conversation.tabs.map((tab) => tab.id === tabId ? { ...tab, ...patch, lastUpdatedAt: Date.now() } : tab) };
    putLocalRecord(this.home, "browser_tab_state", conversationId, next, saved?.revision ?? null);
    return next;
  }
  async deleteConversation(conversationId: string): Promise<void> {
    deleteLocalRecord(this.home, "browser_tab_state", conversationId);
  }
}

function cloneConversation(conversation: StoredBrowserConversation | undefined): StoredBrowserConversation {
  const tabs = Array.isArray(conversation?.tabs)
    ? conversation.tabs
        .filter((tab): tab is StoredBrowserTab => Boolean(tab?.id))
        .map((tab) => ({
          id: String(tab.id),
          url: typeof tab.url === "string" ? tab.url : "",
          title: typeof tab.title === "string" ? tab.title : null,
          faviconUrl: typeof tab.faviconUrl === "string" ? tab.faviconUrl : null,
          lastUpdatedAt: Number.isFinite(tab.lastUpdatedAt) ? tab.lastUpdatedAt : Date.now(),
          ...(tab.navigation?.entries.length && Number.isInteger(tab.navigation.index)
            && tab.navigation.index >= 0 && tab.navigation.index < tab.navigation.entries.length
            ? { navigation: { index: tab.navigation.index, entries: tab.navigation.entries.map((entry) => ({ ...entry })) } }
            : {}),
        }))
    : [];
  const activeTabId =
    typeof conversation?.activeTabId === "string" && tabs.some((tab) => tab.id === conversation.activeTabId)
      ? conversation.activeTabId
      : tabs[0]?.id ?? null;
  return { activeTabId, tabs };
}
