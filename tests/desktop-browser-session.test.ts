import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, expect, test, vi } from "vitest";
import { initializeHome } from "../packages/persistence/src/index";
import { BrowserSidebarStore } from "../apps/desktop/src/desktop-browser-store";
import { BrowserSidebarManager } from "../apps/desktop/src/desktop-browser-sidebar";

const native = vi.hoisted(() => ({ views: [] as any[], sessions: new Map<string, any>() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const fromPartition = (partition: string) => {
    if (!native.sessions.has(partition)) native.sessions.set(partition, {
      setPermissionRequestHandler() {}, flushStorageData: vi.fn(),
      cookies: { flushStore: vi.fn(async () => {}) },
      clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
    });
    return native.sessions.get(partition);
  };
  class WebContentsView {
    visible = false;
    webContents: any;
    constructor({ webPreferences }: any) {
      let entries: { url: string; title: string; pageState?: string }[] = [];
      let index = -1;
      let destroyed = false;
      const contents = Object.assign(new EventEmitter(), {
        session: fromPartition(webPreferences.partition),
        getURL: () => entries[index]?.url ?? "",
        getTitle: () => entries[index]?.title ?? "",
        isDestroyed: () => destroyed,
        close: () => { destroyed = true; },
        setWindowOpenHandler() {},
        loadURL: async (url: string) => {
          contents.emit("did-start-loading");
          entries = [...entries.slice(0, index + 1), { url, title: url, pageState: `state:${url}` }];
          index = entries.length - 1;
          contents.emit("did-navigate");
          contents.emit("did-stop-loading");
        },
        navigationHistory: {
          getAllEntries: () => structuredClone(entries),
          getActiveIndex: () => index,
          canGoBack: () => index > 0,
          canGoForward: () => index < entries.length - 1,
          goBack: () => { index--; contents.emit("did-navigate"); },
          restore: async (saved: { index: number; entries: typeof entries }) => {
            entries = structuredClone(saved.entries); index = saved.index;
            contents.emit("did-navigate");
          },
        },
      });
      this.webContents = contents;
      native.views.push(this);
    }
    setVisible(visible: boolean) { this.visible = visible; }
    getVisible() { return this.visible; }
    setBounds() {}
  }
  return { WebContentsView, BrowserWindow: class {}, session: { fromPartition }, shell: {} };
});

const managers: BrowserSidebarManager[] = [];
const homes: string[] = [];
const bounds = { x: 0, y: 0, width: 800, height: 600 };
async function setup(home?: string) {
  if (!home) {
    home = await mkdtemp(path.join(tmpdir(), "openpond-browser-test-"));
    homes.push(home);
    await initializeHome(home);
  }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: { send: vi.fn() },
  });
  const store = new BrowserSidebarStore(home);
  const manager = new BrowserSidebarManager(window as unknown as BrowserWindow, store);
  managers.push(manager);
  return { manager, store, window, home };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  native.views.length = 0;
  native.sessions.clear();
});

// Failure story: switching chats used separate login stores; evicting a tab or
// restarting the manager discarded its back/forward stack and active entry.
test("shares the website session and restores tab history after eviction and restart", async () => {
  const { manager, home, store } = await setup();
  await manager.setBounds({ conversationId: "a", bounds });
  await manager.newTab({ conversationId: "a", url: "https://example.test/first" });
  const original = (await manager.state("a")).activeTabId!;
  await manager.open({ conversationId: "a", url: "https://example.test/second" });
  await manager.open({ conversationId: "a", url: "https://example.test/third" });
  await manager.back({ conversationId: "a", tabId: original });
  for (let i = 0; i < 4; i++) await manager.newTab({ conversationId: "a", url: `https://example.test/${i}` });
  expect(manager.diagnostics().recentEvictions.some(item => item.tabId === original)).toBe(true);
  await manager.selectTab({ conversationId: "a", tabId: original });
  expect((await manager.state("a")).tabs.find(tab => tab.id === original)).toMatchObject({
    url: "https://example.test/second", canGoBack: true, canGoForward: true,
  });
  await manager.setBounds({ conversationId: "b", bounds });
  await manager.newTab({ conversationId: "b", url: "https://example.test/account" });
  expect(new Set(native.views.map(view => view.webContents.session)).size).toBe(1);
  await manager.shutdown();
  expect((await store.conversation("a")).tabs.find(tab => tab.id === original)?.navigation).toMatchObject({
    index: 1, entries: [{ url: "https://example.test/first" }, { url: "https://example.test/second" }, { url: "https://example.test/third" }],
  });
  const restarted = await setup(home);
  await restarted.manager.setBounds({ conversationId: "a", bounds });
  expect((await restarted.manager.state("a")).tabs.find(tab => tab.id === original)).toMatchObject({
    url: "https://example.test/second", canGoBack: true, canGoForward: true,
  });
  await restarted.manager.clearData({ conversationId: "a" });
  expect((await restarted.manager.state("a")).tabs).toEqual([]);
  expect([...native.sessions.values()][0].clearStorageData).toHaveBeenCalledOnce();
});

// Failure story: simultaneous new tabs overwrote each other's saved list, while
// delayed state events or navigation could switch the visible chat back.
test("retains overlapping new tabs and keeps late navigation in its originating chat", async () => {
  const { manager, window } = await setup();
  await manager.setBounds({ conversationId: "a", bounds });
  await Promise.all([
    manager.newTab({ conversationId: "a", url: "https://example.test/one" }),
    manager.newTab({ conversationId: "a", url: "https://example.test/two" }),
  ]);
  const a = await manager.state("a");
  expect(a.tabs.map(tab => tab.url)).toEqual(["https://example.test/one", "https://example.test/two"]);
  await manager.setBounds({ conversationId: "b", bounds });
  await manager.newTab({ conversationId: "b", url: "https://example.test/b" });
  // Old viewport cleanup must not hide the newly selected chat's view.
  await manager.setBounds({ conversationId: "a", bounds: null });
  await manager.open({ conversationId: "a", url: "https://example.test/late" });
  expect(manager.diagnostics()).toMatchObject({ activeConversationId: "b", attachedRuntimeCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 50));
  const emitted = window.webContents.send.mock.calls.filter(([channel, state]) => channel === "openpond:browser:state" && state.conversationId === "a").at(-1)?.[1];
  expect(emitted.tabs).toHaveLength(2);
  expect(emitted.activeTabId).toBe(a.activeTabId);
});
