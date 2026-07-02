export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserCommandResult = {
  ok: boolean;
  error?: string;
};

export type BrowserConversationInput = {
  conversationId: string;
};

export type BrowserTabInput = BrowserConversationInput & {
  tabId: string;
};

export type BrowserUrlInput = BrowserConversationInput & {
  url: string;
  explicitFile?: boolean;
};

export type BrowserNewTabInput = BrowserConversationInput & {
  url?: string;
  explicitFile?: boolean;
};

export type BrowserNavigateInput = BrowserTabInput & BrowserUrlInput;

export type BrowserBoundsInput = BrowserConversationInput & {
  bounds: BrowserBounds | null;
};

export type BrowserEvictionDecision = {
  at: number;
  conversationId: string;
  reason: "idle_ttl" | "conversation_inactive_limit" | "global_warm_view_limit";
  runtimeCount: number;
  tabId: string;
};

export type BrowserDiagnostics = {
  activeConversationId: string | null;
  attachedRuntimeCount: number;
  limits: {
    conversationInactiveViewLimit: number;
    globalWarmViewLimit: number;
    idleViewTtlMs: number;
  };
  pendingStateEmitCount: number;
  pendingTabPersistCount: number;
  recentEvictions: BrowserEvictionDecision[];
  runtimeCount: number;
};

export type BrowserTabState = {
  id: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
};

export type BrowserConversationState = {
  conversationId: string;
  activeTabId: string | null;
  tabs: BrowserTabState[];
};

export type StoredBrowserTab = {
  id: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  lastUpdatedAt: number;
};

export type StoredBrowserConversation = {
  activeTabId: string | null;
  tabs: StoredBrowserTab[];
};

export type BrowserMetadataFile = {
  conversations: Record<string, StoredBrowserConversation>;
};
