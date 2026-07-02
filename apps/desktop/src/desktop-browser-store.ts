import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BrowserMetadataFile,
  StoredBrowserConversation,
  StoredBrowserTab,
} from "./desktop-browser-types.js";

const EMPTY_METADATA: BrowserMetadataFile = { conversations: {} };

export class BrowserSidebarStore {
  private loaded = false;
  private metadata: BrowserMetadataFile = EMPTY_METADATA;

  constructor(private readonly userDataDir: string) {}

  async conversation(conversationId: string): Promise<StoredBrowserConversation> {
    await this.ensureLoaded();
    return cloneConversation(this.metadata.conversations[conversationId]);
  }

  async saveConversation(conversationId: string, conversation: StoredBrowserConversation): Promise<void> {
    await this.ensureLoaded();
    this.metadata = {
      conversations: {
        ...this.metadata.conversations,
        [conversationId]: cloneConversation(conversation),
      },
    };
    await this.write();
  }

  async updateTab(
    conversationId: string,
    tabId: string,
    patch: Partial<Omit<StoredBrowserTab, "id">>,
  ): Promise<StoredBrowserConversation> {
    const conversation = await this.conversation(conversationId);
    const tabs = conversation.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, ...patch, lastUpdatedAt: Date.now() } : tab,
    );
    const next = { ...conversation, tabs };
    await this.saveConversation(conversationId, next);
    return next;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.ensureLoaded();
    const { [conversationId]: _removed, ...conversations } = this.metadata.conversations;
    this.metadata = { conversations };
    await this.write();
  }

  private get filePath(): string {
    return path.join(this.userDataDir, "browser-sidebar-state.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.metadata = normalizeMetadata(JSON.parse(raw));
    } catch {
      this.metadata = EMPTY_METADATA;
    }
    this.loaded = true;
  }

  private async write(): Promise<void> {
    await fs.mkdir(this.userDataDir, { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.metadata, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

function normalizeMetadata(value: unknown): BrowserMetadataFile {
  if (!value || typeof value !== "object") return EMPTY_METADATA;
  const rawConversations = (value as { conversations?: unknown }).conversations;
  if (!rawConversations || typeof rawConversations !== "object") return EMPTY_METADATA;
  const conversations: Record<string, StoredBrowserConversation> = {};
  for (const [conversationId, rawConversation] of Object.entries(rawConversations)) {
    conversations[conversationId] = cloneConversation(rawConversation as StoredBrowserConversation | undefined);
  }
  return { conversations };
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
