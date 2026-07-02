import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
} from "electron";
import { BrowserSidebarStore } from "./desktop-browser-store.js";
import { normalizeBrowserUrl, openUrlExternal, partitionForConversation } from "./desktop-browser-url.js";
import { createTabId, ensureStoredTab, runtimeKey, sanitizeBounds } from "./desktop-browser-utils.js";
import type {
  BrowserBounds,
  BrowserBoundsInput,
  BrowserConversationInput,
  BrowserConversationState,
  BrowserDiagnostics,
  BrowserEvictionDecision,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserTabInput,
  BrowserTabState,
  BrowserUrlInput,
  StoredBrowserConversation,
  StoredBrowserTab,
} from "./desktop-browser-types.js";

const GLOBAL_WARM_VIEW_LIMIT = 8;
const CONVERSATION_INACTIVE_VIEW_LIMIT = 3;
const IDLE_VIEW_TTL_MS = 10 * 60_000;
const METADATA_PERSIST_DEBOUNCE_MS = 150;
const STATE_EMIT_DEBOUNCE_MS = 25;

type RuntimeTab = {
  conversationId: string;
  tabId: string;
  view: WebContentsView;
  loading: boolean;
  error: string | null;
  lastUsedAt: number;
};

type PendingTabPersist = {
  conversationId: string;
  tabId: string;
  patch: Partial<Omit<StoredBrowserTab, "id">>;
  timer: NodeJS.Timeout;
};

type PendingStateEmit = {
  conversation?: StoredBrowserConversation;
  timer: NodeJS.Timeout;
};

export class BrowserSidebarManager {
  private activeConversationId: string | null = null;
  private bounds: BrowserBounds | null = null;
  private readonly runtimes = new Map<string, RuntimeTab>();
  private readonly pendingStateEmits = new Map<string, PendingStateEmit>();
  private readonly pendingTabPersists = new Map<string, PendingTabPersist>();
  private readonly recentEvictions: BrowserEvictionDecision[] = [];
  private readonly evictionTimer: NodeJS.Timeout;
  private destroyed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly store: BrowserSidebarStore,
  ) {
    this.evictionTimer = setInterval(() => this.enforceMemoryPolicy(), 60_000);
    this.evictionTimer.unref?.();
    window.once("closed", () => this.destroy());
  }

  async open(input: BrowserUrlInput): Promise<void> {
    const url = normalizeBrowserUrl(input.url, input.explicitFile);
    const conversation = await this.store.conversation(input.conversationId);
    const tabId = conversation.activeTabId ?? createTabId();
    const next = ensureStoredTab(conversation, tabId, url);
    await this.store.saveConversation(input.conversationId, next);
    await this.loadTab(input.conversationId, tabId, url);
  }

  async newTab(input: BrowserNewTabInput): Promise<void> {
    const url = input.url ? normalizeBrowserUrl(input.url, input.explicitFile) : "";
    const tab: StoredBrowserTab = { id: createTabId(), url, title: null, faviconUrl: null, lastUpdatedAt: Date.now() };
    const conversation = await this.store.conversation(input.conversationId);
    await this.store.saveConversation(input.conversationId, {
      activeTabId: tab.id,
      tabs: [...conversation.tabs, tab],
    });
    await this.loadTab(input.conversationId, tab.id, url);
  }

  async navigate(input: BrowserNavigateInput): Promise<void> {
    await this.store.updateTab(input.conversationId, input.tabId, {
      url: normalizeBrowserUrl(input.url, input.explicitFile),
      title: null,
      faviconUrl: null,
    });
    await this.loadTab(input.conversationId, input.tabId, input.url);
  }

  async selectTab(input: BrowserTabInput): Promise<void> {
    const conversation = await this.store.conversation(input.conversationId);
    if (!conversation.tabs.some((tab) => tab.id === input.tabId)) return;
    await this.store.saveConversation(input.conversationId, { ...conversation, activeTabId: input.tabId });
    await this.attachActive(input.conversationId);
  }

  async closeTab(input: BrowserTabInput): Promise<void> {
    this.destroyRuntime(input.conversationId, input.tabId);
    const conversation = await this.store.conversation(input.conversationId);
    const tabs = conversation.tabs.filter((tab) => tab.id !== input.tabId);
    const activeTabId = conversation.activeTabId === input.tabId ? tabs.at(-1)?.id ?? null : conversation.activeTabId;
    await this.store.saveConversation(input.conversationId, { activeTabId, tabs });
    await this.attachActive(input.conversationId);
  }

  async back(input: BrowserTabInput): Promise<void> {
    this.runtime(input)?.view.webContents.navigationHistory.goBack();
  }

  async forward(input: BrowserTabInput): Promise<void> {
    this.runtime(input)?.view.webContents.navigationHistory.goForward();
  }

  async reload(input: BrowserTabInput): Promise<void> {
    this.runtime(input)?.view.webContents.reload();
  }

  async stop(input: BrowserTabInput): Promise<void> {
    this.runtime(input)?.view.webContents.stop();
  }

  async close(input: BrowserConversationInput): Promise<void> {
    if (this.activeConversationId === input.conversationId) {
      this.bounds = null;
      this.detachAll();
    }
  }

  async clearData(input: BrowserConversationInput): Promise<void> {
    for (const runtime of Array.from(this.runtimes.values())) {
      if (runtime.conversationId === input.conversationId) this.destroyRuntime(runtime.conversationId, runtime.tabId);
    }
    const partition = partitionForConversation(input.conversationId);
    await electronSession.fromPartition(partition).clearStorageData();
    await electronSession.fromPartition(partition).clearCache();
    await this.store.deleteConversation(input.conversationId);
    this.emitState(input.conversationId);
  }

  async openExternal(input: BrowserTabInput | BrowserUrlInput): Promise<void> {
    const url = "tabId" in input ? (await this.tab(input))?.url : normalizeBrowserUrl(input.url, input.explicitFile);
    if (!url) return;
    await openUrlExternal(url);
  }

  async setBounds(input: BrowserBoundsInput): Promise<void> {
    this.activeConversationId = input.conversationId;
    this.bounds = sanitizeBounds(input.bounds);
    await this.attachActive(input.conversationId);
  }

  async state(conversationId: string): Promise<BrowserConversationState> {
    const conversation = await this.store.conversation(conversationId);
    return this.buildState(conversationId, conversation);
  }

  diagnostics(): BrowserDiagnostics {
    return {
      activeConversationId: this.activeConversationId,
      attachedRuntimeCount: Array.from(this.runtimes.values()).filter((runtime) => runtime.view.getVisible()).length,
      limits: {
        conversationInactiveViewLimit: CONVERSATION_INACTIVE_VIEW_LIMIT,
        globalWarmViewLimit: GLOBAL_WARM_VIEW_LIMIT,
        idleViewTtlMs: IDLE_VIEW_TTL_MS,
      },
      pendingStateEmitCount: this.pendingStateEmits.size,
      pendingTabPersistCount: this.pendingTabPersists.size,
      recentEvictions: [...this.recentEvictions],
      runtimeCount: this.runtimes.size,
    };
  }

  private async loadTab(conversationId: string, tabId: string, rawUrl: string): Promise<void> {
    const url = rawUrl ? normalizeBrowserUrl(rawUrl, rawUrl.startsWith("file://")) : "";
    const runtime = await this.ensureRuntime(conversationId, tabId);
    await this.store.updateTab(conversationId, tabId, { url, title: null, faviconUrl: null });
    if (url) await runtime.view.webContents.loadURL(url);
    await this.attachActive(conversationId);
  }

  private async attachActive(conversationId: string): Promise<void> {
    const conversation = await this.store.conversation(conversationId);
    this.activeConversationId = conversationId;
    this.detachAll();
    if (!this.bounds || !conversation.activeTabId) {
      this.emitState(conversationId, conversation);
      return;
    }
    const runtime = await this.ensureRuntime(conversationId, conversation.activeTabId);
    runtime.lastUsedAt = Date.now();
    this.window.contentView.addChildView(runtime.view);
    runtime.view.setBounds(this.bounds);
    runtime.view.setVisible(true);
    this.enforceMemoryPolicy();
    this.emitState(conversationId, conversation);
  }

  private async ensureRuntime(conversationId: string, tabId: string): Promise<RuntimeTab> {
    const key = runtimeKey(conversationId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = this.createRuntime(conversationId, tabId);
    this.runtimes.set(key, runtime);
    const tab = await this.tab({ conversationId, tabId });
    if (tab?.url) void runtime.view.webContents.loadURL(tab.url).catch(() => undefined);
    return runtime;
  }

  private createRuntime(conversationId: string, tabId: string): RuntimeTab {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: partitionForConversation(conversationId),
        sandbox: true,
      },
    });
    const runtime: RuntimeTab = { conversationId, tabId, view, loading: false, error: null, lastUsedAt: Date.now() };
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        void this.newTab({ conversationId, url: normalizeBrowserUrl(url, false) });
      } catch {
        void openUrlExternal(url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    view.webContents.on("did-start-loading", () => this.patchRuntime(runtime, { loading: true, error: null }));
    view.webContents.on("did-stop-loading", () => this.patchRuntime(runtime, { loading: false }));
    view.webContents.on("did-finish-load", () => this.persistRuntime(runtime));
    view.webContents.on("did-navigate", () => this.persistRuntime(runtime));
    view.webContents.on("did-navigate-in-page", () => this.persistRuntime(runtime));
    view.webContents.on("page-title-updated", () => this.persistRuntime(runtime));
    view.webContents.on("page-favicon-updated", (_event, favicons) => this.persistFavicon(runtime, favicons[0] ?? null));
    view.webContents.on("did-fail-load", (_event, code, description) => {
      if (code !== -3) this.patchRuntime(runtime, { loading: false, error: description });
    });
    return runtime;
  }

  private patchRuntime(runtime: RuntimeTab, patch: Partial<Pick<RuntimeTab, "error" | "loading">>): void {
    Object.assign(runtime, patch);
    this.emitState(runtime.conversationId);
  }

  private persistRuntime(runtime: RuntimeTab): void {
    if (this.destroyed || runtime.view.webContents.isDestroyed()) return;
    const url = pageUrl(runtime);
    runtime.error = null;
    this.scheduleTabPersist(runtime, {
      title: runtime.view.webContents.getTitle() || null,
      url,
    });
  }

  private persistFavicon(runtime: RuntimeTab, faviconUrl: string | null): void {
    this.scheduleTabPersist(runtime, { faviconUrl });
  }

  private scheduleTabPersist(runtime: RuntimeTab, patch: Partial<Omit<StoredBrowserTab, "id">>): void {
    if (this.destroyed) return;
    const key = runtimeKey(runtime.conversationId, runtime.tabId);
    const existing = this.pendingTabPersists.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => void this.flushTabPersist(key), METADATA_PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingTabPersists.set(key, {
      conversationId: runtime.conversationId,
      tabId: runtime.tabId,
      patch: { ...existing?.patch, ...patch },
      timer,
    });
    this.emitState(runtime.conversationId);
  }

  private async flushTabPersist(key: string, emit = true): Promise<void> {
    const pending = this.pendingTabPersists.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTabPersists.delete(key);
    const conversation = await this.store.updateTab(pending.conversationId, pending.tabId, pending.patch);
    if (emit) this.emitState(pending.conversationId, conversation);
  }

  private async tab(input: BrowserTabInput): Promise<StoredBrowserTab | null> {
    const conversation = await this.store.conversation(input.conversationId);
    return conversation.tabs.find((tab) => tab.id === input.tabId) ?? null;
  }

  private runtime(input: BrowserTabInput): RuntimeTab | null {
    return this.runtimes.get(runtimeKey(input.conversationId, input.tabId)) ?? null;
  }

  private buildState(conversationId: string, conversation: StoredBrowserConversation): BrowserConversationState {
    return {
      conversationId,
      activeTabId: conversation.activeTabId,
      tabs: conversation.tabs.map((tab) => this.tabState(conversationId, tab)),
    };
  }

  private tabState(conversationId: string, tab: StoredBrowserTab): BrowserTabState {
    const runtime = this.runtimes.get(runtimeKey(conversationId, tab.id));
    const contents = runtime?.view.webContents;
    return {
      id: tab.id,
      url: runtime ? pageUrl(runtime) : tab.url,
      title: contents?.getTitle() || tab.title,
      faviconUrl: tab.faviconUrl,
      loading: runtime?.loading ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      error: runtime?.error ?? null,
    };
  }

  private emitState(conversationId: string, conversation?: StoredBrowserConversation): void {
    if (this.destroyed) return;
    const existing = this.pendingStateEmits.get(conversationId);
    if (existing) {
      if (conversation) existing.conversation = conversation;
      return;
    }
    const timer = setTimeout(() => void this.flushStateEmit(conversationId), STATE_EMIT_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingStateEmits.set(conversationId, { conversation, timer });
  }

  private async flushStateEmit(conversationId: string): Promise<void> {
    if (this.destroyed) return;
    const pending = this.pendingStateEmits.get(conversationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingStateEmits.delete(conversationId);
    const next = pending.conversation ?? await this.store.conversation(conversationId);
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("openpond:browser:state", this.buildState(conversationId, next));
    }
  }

  private detachAll(): void {
    for (const runtime of this.runtimes.values()) {
      this.detachRuntimeView(runtime);
    }
  }

  private enforceMemoryPolicy(): void {
    const activeKey = this.activeConversationId
      ? runtimeKey(this.activeConversationId, this.activeTabIdFor(this.activeConversationId))
      : null;
    const now = Date.now();
    const candidates = Array.from(this.runtimes.values())
      .filter((runtime) => runtimeKey(runtime.conversationId, runtime.tabId) !== activeKey)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const removeReasons = new Map<string, BrowserEvictionDecision["reason"]>();
    for (const runtime of candidates.filter((candidate) => now - candidate.lastUsedAt > IDLE_VIEW_TTL_MS)) {
      removeReasons.set(runtimeKey(runtime.conversationId, runtime.tabId), "idle_ttl");
    }
    const byConversation = new Map<string, RuntimeTab[]>();
    for (const runtime of candidates) {
      const group = byConversation.get(runtime.conversationId);
      if (group) group.push(runtime);
      else byConversation.set(runtime.conversationId, [runtime]);
    }
    for (const group of byConversation.values()) {
      for (const runtime of group.slice(0, Math.max(0, group.length - CONVERSATION_INACTIVE_VIEW_LIMIT))) {
        removeReasons.set(runtimeKey(runtime.conversationId, runtime.tabId), "conversation_inactive_limit");
      }
    }
    const projectedSize = this.runtimes.size - removeReasons.size;
    const globalExcess = Math.max(0, projectedSize - GLOBAL_WARM_VIEW_LIMIT);
    for (const runtime of candidates.filter((candidate) => !removeReasons.has(runtimeKey(candidate.conversationId, candidate.tabId))).slice(0, globalExcess)) {
      removeReasons.set(runtimeKey(runtime.conversationId, runtime.tabId), "global_warm_view_limit");
    }
    for (const [key, reason] of removeReasons) {
      const runtime = this.runtimes.get(key);
      if (runtime) this.destroyRuntime(runtime.conversationId, runtime.tabId, reason);
    }
  }

  private activeTabIdFor(conversationId: string): string {
    for (const runtime of this.runtimes.values()) {
      if (runtime.conversationId === conversationId && runtime.view.getVisible()) return runtime.tabId;
    }
    return "";
  }

  private destroyRuntime(conversationId: string, tabId: string, reason?: BrowserEvictionDecision["reason"]): void {
    const key = runtimeKey(conversationId, tabId);
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    if (reason) this.recordEviction(runtime, reason);
    this.runtimes.delete(key);
    this.detachRuntimeView(runtime);
    try {
      if (!runtime.view.webContents.isDestroyed()) {
        runtime.view.webContents.close({ waitForBeforeUnload: false });
      }
    } catch (error) {
      if (!isDestroyedElectronObjectError(error)) throw error;
    }
  }

  private detachRuntimeView(runtime: RuntimeTab): void {
    if (this.window.isDestroyed()) return;
    try {
      this.window.contentView.removeChildView(runtime.view);
    } catch (error) {
      if (!isDestroyedElectronObjectError(error)) throw error;
    }
    try {
      runtime.view.setVisible(false);
    } catch (error) {
      if (!isDestroyedElectronObjectError(error)) throw error;
    }
  }

  private recordEviction(runtime: RuntimeTab, reason: BrowserEvictionDecision["reason"]): void {
    this.recentEvictions.push({
      at: Date.now(),
      conversationId: runtime.conversationId,
      reason,
      runtimeCount: this.runtimes.size,
      tabId: runtime.tabId,
    });
    this.recentEvictions.splice(0, Math.max(0, this.recentEvictions.length - 20));
  }

  private destroy(): void {
    this.destroyed = true;
    clearInterval(this.evictionTimer);
    for (const pending of this.pendingStateEmits.values()) clearTimeout(pending.timer);
    this.pendingStateEmits.clear();
    for (const [key, pending] of this.pendingTabPersists) {
      clearTimeout(pending.timer);
      void this.flushTabPersist(key, false);
    }
    for (const runtime of Array.from(this.runtimes.values())) this.destroyRuntime(runtime.conversationId, runtime.tabId);
  }
}

function pageUrl(runtime: RuntimeTab): string {
  if (runtime.view.webContents.isDestroyed()) return "";
  const url = runtime.view.webContents.getURL();
  return url === "about:blank" ? "" : url;
}

function isDestroyedElectronObjectError(error: unknown): boolean {
  return error instanceof Error && /Object has been destroyed/i.test(error.message);
}
