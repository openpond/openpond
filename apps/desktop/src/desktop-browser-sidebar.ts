import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
} from "electron";
import { randomUUID } from "node:crypto";
import { BrowserSidebarStore } from "./desktop-browser-store.js";
import { normalizeBrowserUrl, openUrlExternal, partitionForConversation } from "./desktop-browser-url.js";
import { createTabId, ensureStoredTab, runtimeKey, sanitizeBounds } from "./desktop-browser-utils.js";
import {
  collectBrowserSnapshotTargetsScript,
  parseBrowserSnapshotScriptResult,
  parseBrowserTargetResolutionResult,
  resolveBrowserSnapshotTargetScript,
  resolvedPointFromViewportPoint,
  snapshotTargetForModel,
  updateBrowserCursorOverlayScript,
  type BrowserSnapshotScriptTarget,
} from "./desktop-browser-harness-dom.js";
import type {
  BrowserHarnessClickInput,
  BrowserHarnessKey,
  BrowserHarnessKeyInput,
  BrowserHarnessMoveCursorInput,
  BrowserHarnessOpenInput,
  BrowserHarnessResolvedTarget,
  BrowserHarnessResponseMetadata,
  BrowserHarnessResult,
  BrowserHarnessScrollInput,
  BrowserHarnessSnapshotInput,
  BrowserHarnessTarget,
  BrowserHarnessTypeTextInput,
} from "./desktop-browser-harness-types.js";
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
const SNAPSHOT_CACHE_LIMIT = 20;
const SNAPSHOT_CACHE_TTL_MS = 5 * 60_000;
const HARNESS_REVEAL_TIMEOUT_MS = 5_000;
const HARNESS_REVEAL_POLL_MS = 50;

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

type BrowserSnapshotCache = {
  snapshotId: string;
  conversationId: string;
  tabId: string;
  createdAt: number;
  targets: Map<string, BrowserSnapshotScriptTarget>;
};

export class BrowserSidebarManager {
  private activeConversationId: string | null = null;
  private bounds: BrowserBounds | null = null;
  private readonly runtimes = new Map<string, RuntimeTab>();
  private readonly snapshotCaches = new Map<string, BrowserSnapshotCache>();
  private readonly pendingStateEmits = new Map<string, PendingStateEmit>();
  private readonly pendingTabPersists = new Map<string, PendingTabPersist>();
  private readonly boundsWaiters = new Set<() => void>();
  private readonly recentEvictions: BrowserEvictionDecision[] = [];
  private readonly evictionTimer: NodeJS.Timeout;
  private cursor = { x: 0, y: 0 };
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
    this.notifyBoundsWaiters();
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

  async harnessOpen(input: BrowserHarnessOpenInput): Promise<BrowserHarnessResult> {
    if (input.url) {
      await this.open({ conversationId: input.conversationId, url: input.url });
    } else {
      const conversation = await this.store.conversation(input.conversationId);
      if (input.tabId && conversation.tabs.some((tab) => tab.id === input.tabId)) {
        await this.selectTab({ conversationId: input.conversationId, tabId: input.tabId });
      } else if (conversation.activeTabId) {
        await this.attachActive(input.conversationId);
      } else {
        await this.newTab({ conversationId: input.conversationId });
      }
    }
    await this.requestPanelReveal(input.conversationId);
    const metadata = await this.harnessMetadata(input);
    return {
      ok: true,
      output: input.url ? "Browser opened." : "Browser focused.",
      metadata,
    };
  }

  async harnessSnapshot(input: BrowserHarnessSnapshotInput): Promise<BrowserHarnessResult> {
    const runtime = await this.runtimeForBrowserInput(input, { requireVisible: true, requireLoadedUrl: false });
    await this.waitForRuntimeSettled(runtime);
    const rawSnapshot = await runtime.view.webContents.executeJavaScript(
      collectBrowserSnapshotTargetsScript(input.maxTargets),
      false,
    );
    const snapshot = parseBrowserSnapshotScriptResult(rawSnapshot);
    const snapshotId = `browser_snap_${randomUUID()}`;
    const targets = new Map<string, BrowserSnapshotScriptTarget>(
      snapshot.targets.map((target) => [target.ref, target]),
    );
    this.rememberSnapshot({
      snapshotId,
      conversationId: runtime.conversationId,
      tabId: runtime.tabId,
      createdAt: Date.now(),
      targets,
    });
    let screenshotAvailable = false;
    if (input.includeScreenshot) {
      const screenshot = await runtime.view.webContents.capturePage();
      screenshotAvailable = !screenshot.isEmpty();
    }
    const data = {
      snapshot: {
        snapshotId,
        tabId: runtime.tabId,
        url: snapshot.url,
        title: snapshot.title,
        viewport: snapshot.viewport,
        targets: snapshot.targets.map(snapshotTargetForModel),
      },
    };
    return {
      ok: true,
      output: `Captured browser snapshot with ${snapshot.targets.length} target${snapshot.targets.length === 1 ? "" : "s"}.`,
      data,
      metadata: await this.harnessMetadata(input, {
        snapshotId,
        screenshotAvailable,
        tabId: runtime.tabId,
      }),
    };
  }

  async harnessMoveCursor(input: BrowserHarnessMoveCursorInput): Promise<BrowserHarnessResult> {
    const runtime = await this.runtimeForTargetAction(input, input.target);
    const target = await this.resolveHarnessTarget(runtime, input.target);
    this.focusRuntime(runtime);
    this.sendMouseMove(runtime, target.point);
    if (input.waitAfterMoveMs > 0) await delay(input.waitAfterMoveMs);
    return {
      ok: true,
      output: target.name ? `Moved browser cursor to ${target.name}.` : "Moved browser cursor.",
      metadata: await this.harnessMetadata(input, { cursor: target.point, tabId: runtime.tabId }),
    };
  }

  async harnessClick(input: BrowserHarnessClickInput): Promise<BrowserHarnessResult> {
    const runtime = await this.runtimeForTargetAction(input, input.target);
    const target = await this.resolveHarnessTarget(runtime, input.target);
    this.focusRuntime(runtime);
    this.sendMouseMove(runtime, target.point);
    for (let index = 0; index < input.clickCount; index += 1) {
      runtime.view.webContents.sendInputEvent({
        type: "mouseDown",
        x: Math.round(target.point.x),
        y: Math.round(target.point.y),
        button: input.button,
        clickCount: input.clickCount,
      });
      runtime.view.webContents.sendInputEvent({
        type: "mouseUp",
        x: Math.round(target.point.x),
        y: Math.round(target.point.y),
        button: input.button,
        clickCount: input.clickCount,
      });
    }
    void this.updateCursorOverlay(runtime, target.point, { click: true });
    await delay(40);
    return {
      ok: true,
      output: target.name ? `Clicked ${target.name}.` : "Clicked browser target.",
      metadata: await this.harnessMetadata(input, { cursor: target.point, tabId: runtime.tabId }),
    };
  }

  async harnessTypeText(input: BrowserHarnessTypeTextInput): Promise<BrowserHarnessResult> {
    const runtime = await this.runtimeForTargetAction(input, input.target);
    let cursor = this.cursor;
    if (input.target) {
      const target = await this.resolveHarnessTarget(runtime, input.target);
      this.focusRuntime(runtime);
      this.sendMouseMove(runtime, target.point);
      runtime.view.webContents.sendInputEvent({
        type: "mouseDown",
        x: Math.round(target.point.x),
        y: Math.round(target.point.y),
        button: "left",
        clickCount: 1,
      });
      runtime.view.webContents.sendInputEvent({
        type: "mouseUp",
        x: Math.round(target.point.x),
        y: Math.round(target.point.y),
        button: "left",
        clickCount: 1,
      });
      void this.updateCursorOverlay(runtime, target.point, { click: true });
      cursor = target.point;
      await delay(20);
    } else {
      this.focusRuntime(runtime);
    }
    runtime.view.webContents.insertText(input.text);
    return {
      ok: true,
      output: `Typed ${input.text.length} character${input.text.length === 1 ? "" : "s"} in browser.`,
      metadata: await this.harnessMetadata(input, { cursor, tabId: runtime.tabId }),
    };
  }

  async harnessKey(input: BrowserHarnessKeyInput): Promise<BrowserHarnessResult> {
    const runtime = await this.runtimeForBrowserInput(input, { requireVisible: true, requireLoadedUrl: false });
    this.focusRuntime(runtime);
    const key = browserKeyEvent(input.key);
    runtime.view.webContents.sendInputEvent({
      type: "rawKeyDown",
      keyCode: key.keyCode,
      ...(key.modifiers.length > 0 ? { modifiers: key.modifiers } : {}),
    });
    if (key.charCode) {
      runtime.view.webContents.sendInputEvent({
        type: "char",
        keyCode: key.charCode,
        ...(key.modifiers.length > 0 ? { modifiers: key.modifiers } : {}),
      });
    }
    runtime.view.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: key.keyCode,
      ...(key.modifiers.length > 0 ? { modifiers: key.modifiers } : {}),
    });
    await delay(20);
    return {
      ok: true,
      output: `Pressed ${input.key}.`,
      metadata: await this.harnessMetadata(input, { tabId: runtime.tabId }),
    };
  }

  async harnessScroll(input: BrowserHarnessScrollInput): Promise<BrowserHarnessResult> {
    const runtime = await this.runtimeForTargetAction(input, input.target);
    const target = input.target
      ? await this.resolveHarnessTarget(runtime, input.target)
      : await this.centerTargetForRuntime(runtime);
    this.focusRuntime(runtime);
    this.sendMouseMove(runtime, target.point);
    runtime.view.webContents.sendInputEvent({
      type: "mouseWheel",
      x: Math.round(target.point.x),
      y: Math.round(target.point.y),
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    await delay(50);
    return {
      ok: true,
      output: "Scrolled browser.",
      metadata: await this.harnessMetadata(input, { cursor: target.point, tabId: runtime.tabId }),
    };
  }

  private async runtimeForTargetAction(
    input: { conversationId: string; tabId?: string },
    target?: BrowserHarnessTarget,
  ): Promise<RuntimeTab> {
    if (target?.kind !== "ref") {
      return this.runtimeForBrowserInput(input, { requireVisible: true, requireLoadedUrl: false });
    }
    const cache = this.snapshotCache(target.snapshotId);
    if (cache.conversationId !== input.conversationId) {
      throw new Error("Browser snapshot belongs to a different conversation.");
    }
    if (input.tabId && input.tabId !== cache.tabId) {
      throw new Error("Browser snapshot belongs to a different tab.");
    }
    return this.runtimeForBrowserInput(
      { conversationId: input.conversationId, tabId: cache.tabId },
      { requireVisible: true, requireLoadedUrl: false },
    );
  }

  private async runtimeForBrowserInput(
    input: { conversationId: string; tabId?: string },
    options: { requireVisible?: boolean; requireLoadedUrl?: boolean } = {},
  ): Promise<RuntimeTab> {
    const conversation = await this.store.conversation(input.conversationId);
    const tabId = input.tabId ?? conversation.activeTabId;
    if (!tabId) throw new Error("No active browser tab is available.");
    if (!conversation.tabs.some((tab) => tab.id === tabId)) throw new Error("Browser tab was not found.");
    const existingRuntime = this.runtime({ conversationId: input.conversationId, tabId });
    if (conversation.activeTabId !== tabId) {
      await this.selectTab({ conversationId: input.conversationId, tabId });
    } else if (!existingRuntime || !existingRuntime.view.getVisible()) {
      await this.attachActive(input.conversationId);
    }
    const runtime = await this.ensureRuntime(input.conversationId, tabId);
    runtime.lastUsedAt = Date.now();
    if (options.requireVisible && (!this.bounds || !runtime.view.getVisible())) {
      await this.requestPanelReveal(input.conversationId);
      await this.attachActive(input.conversationId);
    }
    if (options.requireVisible && (!this.bounds || !runtime.view.getVisible())) {
      throw new Error("Open the browser panel before using browser interaction tools.");
    }
    if (options.requireLoadedUrl && !pageUrl(runtime)) {
      throw new Error("Browser tab has no loaded page.");
    }
    return runtime;
  }

  private async requestPanelReveal(conversationId: string): Promise<void> {
    if (this.hasVisibleBounds(conversationId)) return;
    if (this.window.isDestroyed()) throw new Error("App window is no longer available.");
    if (!this.window.isVisible()) this.window.show();
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
    this.window.webContents.send("openpond:browser:reveal", {
      conversationId,
      reason: "model_tool",
    });
    await this.waitForVisibleBounds(conversationId);
  }

  private async waitForVisibleBounds(
    conversationId: string,
    timeoutMs = HARNESS_REVEAL_TIMEOUT_MS,
  ): Promise<void> {
    if (this.hasVisibleBounds(conversationId)) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!this.hasVisibleBounds(conversationId)) return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(interval);
        this.boundsWaiters.delete(check);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Browser panel did not become visible before the browser tool timed out."));
      }, timeoutMs);
      const interval = setInterval(check, HARNESS_REVEAL_POLL_MS);
      this.boundsWaiters.add(check);
      timeout.unref?.();
      interval.unref?.();
      check();
    });
  }

  private hasVisibleBounds(conversationId: string): boolean {
    return this.activeConversationId === conversationId && Boolean(this.bounds);
  }

  private notifyBoundsWaiters(): void {
    for (const waiter of Array.from(this.boundsWaiters)) waiter();
  }

  private async waitForRuntimeSettled(runtime: RuntimeTab, timeoutMs = 10_000): Promise<void> {
    if (!runtime.loading) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        runtime.view.webContents.off("did-stop-loading", finish);
        runtime.view.webContents.off("did-fail-load", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      runtime.view.webContents.once("did-stop-loading", finish);
      runtime.view.webContents.once("did-fail-load", finish);
    });
  }

  private async resolveHarnessTarget(
    runtime: RuntimeTab,
    target: BrowserHarnessTarget,
  ): Promise<BrowserHarnessResolvedTarget> {
    if (target.kind === "point") {
      const viewport = await this.runtimeViewport(runtime);
      return resolvedPointFromViewportPoint({
        x: target.point.x,
        y: target.point.y,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    }
    const cache = this.snapshotCache(target.snapshotId);
    const cached = cache.targets.get(target.targetRef);
    if (!cached) throw new Error("Browser target ref is stale.");
    const resolved = parseBrowserTargetResolutionResult(
      await runtime.view.webContents.executeJavaScript(resolveBrowserSnapshotTargetScript(cached.domPath), true),
    );
    if (!resolved.ok) throw new Error(resolved.reason);
    return {
      point: resolved.point,
      bounds: resolved.bounds,
      ref: target.targetRef,
      role: resolved.role || cached.role,
      name: resolved.name || cached.name,
      tag: resolved.tag || cached.tag,
    };
  }

  private async centerTargetForRuntime(runtime: RuntimeTab): Promise<BrowserHarnessResolvedTarget> {
    const viewport = await this.runtimeViewport(runtime);
    return {
      point: {
        x: Math.round(viewport.width / 2),
        y: Math.round(viewport.height / 2),
      },
      bounds: {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      },
    };
  }

  private async runtimeViewport(runtime: RuntimeTab): Promise<{ width: number; height: number }> {
    const result = await runtime.view.webContents.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
      false,
    );
    const record = result && typeof result === "object" ? result as { width?: unknown; height?: unknown } : {};
    const bounds = runtime.view.getBounds();
    return {
      width: typeof record.width === "number" && Number.isFinite(record.width) && record.width > 0
        ? record.width
        : bounds.width,
      height: typeof record.height === "number" && Number.isFinite(record.height) && record.height > 0
        ? record.height
        : bounds.height,
    };
  }

  private focusRuntime(runtime: RuntimeTab): void {
    if (this.window.isDestroyed()) throw new Error("App window is no longer available.");
    if (!this.window.isVisible()) this.window.show();
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
    runtime.view.webContents.focus();
    runtime.lastUsedAt = Date.now();
  }

  private sendMouseMove(runtime: RuntimeTab, point: { x: number; y: number }): void {
    const next = { x: Math.round(point.x), y: Math.round(point.y) };
    runtime.view.webContents.sendInputEvent({
      type: "mouseMove",
      x: next.x,
      y: next.y,
      movementX: next.x - this.cursor.x,
      movementY: next.y - this.cursor.y,
    });
    this.cursor = next;
    void this.updateCursorOverlay(runtime, next);
  }

  private async updateCursorOverlay(
    runtime: RuntimeTab,
    point: { x: number; y: number },
    options: { click?: boolean } = {},
  ): Promise<void> {
    try {
      await runtime.view.webContents.executeJavaScript(
        updateBrowserCursorOverlayScript({
          x: Math.round(point.x),
          y: Math.round(point.y),
          ...(options.click ? { click: true } : {}),
        }),
        false,
      );
    } catch {
      // Cursor overlay is best-effort observability; native input already ran.
    }
  }

  private async harnessMetadata(
    input: { conversationId: string; tabId?: string },
    extras: {
      cursor?: { x: number; y: number };
      snapshotId?: string;
      screenshotAvailable?: boolean;
      tabId?: string;
    } = {},
  ): Promise<BrowserHarnessResponseMetadata> {
    const conversation = await this.store.conversation(input.conversationId);
    const activeTabId = extras.tabId ?? input.tabId ?? conversation.activeTabId ?? undefined;
    const tab = activeTabId ? conversation.tabs.find((item) => item.id === activeTabId) : null;
    const runtime = activeTabId ? this.runtime({ conversationId: input.conversationId, tabId: activeTabId }) : null;
    const url = runtime ? pageUrl(runtime) : tab?.url;
    const title = runtime?.view.webContents.getTitle() || tab?.title || undefined;
    return {
      ...(activeTabId ? { activeTabId } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      openTabIds: conversation.tabs.map((item) => item.id),
      ...(extras.cursor ? { cursor: { x: Math.round(extras.cursor.x), y: Math.round(extras.cursor.y) } } : {}),
      ...(extras.snapshotId ? { snapshotId: extras.snapshotId } : {}),
      ...(extras.screenshotAvailable && activeTabId && url ? { screenshot: { tabId: activeTabId, url } } : {}),
    };
  }

  private rememberSnapshot(cache: BrowserSnapshotCache): void {
    this.snapshotCaches.set(cache.snapshotId, cache);
    this.pruneSnapshotCaches();
  }

  private snapshotCache(snapshotId: string): BrowserSnapshotCache {
    this.pruneSnapshotCaches();
    const cache = this.snapshotCaches.get(snapshotId);
    if (!cache) throw new Error("Browser snapshot is stale. Capture a fresh browser snapshot.");
    return cache;
  }

  private pruneSnapshotCaches(): void {
    const now = Date.now();
    for (const [snapshotId, cache] of this.snapshotCaches) {
      if (now - cache.createdAt > SNAPSHOT_CACHE_TTL_MS) this.snapshotCaches.delete(snapshotId);
    }
    const ordered = Array.from(this.snapshotCaches.values()).sort((left, right) => left.createdAt - right.createdAt);
    for (const cache of ordered.slice(0, Math.max(0, ordered.length - SNAPSHOT_CACHE_LIMIT))) {
      this.snapshotCaches.delete(cache.snapshotId);
    }
  }

  private clearSnapshotCachesForRuntime(runtime: RuntimeTab): void {
    for (const [snapshotId, cache] of this.snapshotCaches) {
      if (cache.conversationId === runtime.conversationId && cache.tabId === runtime.tabId) {
        this.snapshotCaches.delete(snapshotId);
      }
    }
  }

  private async loadTab(conversationId: string, tabId: string, rawUrl: string): Promise<void> {
    const url = rawUrl ? normalizeBrowserUrl(rawUrl, rawUrl.startsWith("file://")) : "";
    const runtime = await this.ensureRuntime(conversationId, tabId, { restoreStoredUrl: false });
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

  private async ensureRuntime(
    conversationId: string,
    tabId: string,
    options: { restoreStoredUrl?: boolean } = {},
  ): Promise<RuntimeTab> {
    const key = runtimeKey(conversationId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = this.createRuntime(conversationId, tabId);
    this.runtimes.set(key, runtime);
    if (options.restoreStoredUrl !== false) {
      const tab = await this.tab({ conversationId, tabId });
      if (tab?.url) void runtime.view.webContents.loadURL(tab.url).catch(() => undefined);
    }
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
    view.webContents.on("did-finish-load", () => {
      this.clearSnapshotCachesForRuntime(runtime);
      this.persistRuntime(runtime);
    });
    view.webContents.on("did-navigate", () => {
      this.clearSnapshotCachesForRuntime(runtime);
      this.persistRuntime(runtime);
    });
    view.webContents.on("did-navigate-in-page", () => {
      this.clearSnapshotCachesForRuntime(runtime);
      this.persistRuntime(runtime);
    });
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

function browserKeyEvent(key: BrowserHarnessKey): {
  keyCode: string;
  charCode?: string;
  modifiers: NonNullable<Electron.KeyboardInputEvent["modifiers"]>;
} {
  const chord = /^(Ctrl|Meta)\+(.+)$/.exec(key);
  if (!chord) {
    const charCode = browserKeyCharacter(key);
    return {
      keyCode: electronKeyCode(key),
      ...(charCode ? { charCode } : {}),
      modifiers: [],
    };
  }
  return {
    keyCode: electronKeyCode(chord[2]!),
    modifiers: chord[1] === "Ctrl" ? ["control"] : ["meta"],
  };
}

function electronKeyCode(key: string): string {
  if (key === "Enter") return "Enter";
  if (key === "Space") return "Space";
  return key;
}

function browserKeyCharacter(key: BrowserHarnessKey): string | undefined {
  if (key === "Enter") return "\r";
  if (key === "Space") return " ";
  return undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isDestroyedElectronObjectError(error: unknown): boolean {
  return error instanceof Error && /Object has been destroyed/i.test(error.message);
}
