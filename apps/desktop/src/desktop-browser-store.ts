import { getLocalRecord, putLocalRecord, deleteLocalRecord } from "@openpond/persistence";
import type { StoredBrowserConversation, StoredBrowserTab } from "./desktop-browser-types.js";

export class BrowserSidebarStore {
  constructor(private readonly home: string) {}
  async conversation(conversationId: string): Promise<StoredBrowserConversation> {
    return cloneConversation(getLocalRecord<StoredBrowserConversation>(this.home, "browser_tab_state", conversationId)?.value);
  }
  async saveConversation(conversationId: string, conversation: StoredBrowserConversation): Promise<void> {
    putLocalRecord(this.home, "browser_tab_state", conversationId, cloneConversation(conversation));
  }
  async updateTab(conversationId: string, tabId: string, patch: Partial<Omit<StoredBrowserTab, "id">>): Promise<StoredBrowserConversation> {
    const saved = getLocalRecord<StoredBrowserConversation>(this.home, "browser_tab_state", conversationId);
    const conversation = cloneConversation(saved?.value);
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
        }))
    : [];
  const activeTabId =
    typeof conversation?.activeTabId === "string" && tabs.some((tab) => tab.id === conversation.activeTabId)
      ? conversation.activeTabId
      : tabs[0]?.id ?? null;
  return { activeTabId, tabs };
}
