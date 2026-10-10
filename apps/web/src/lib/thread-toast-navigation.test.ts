import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

// A toast click must never bypass an editor guard or complete navigation into a
// different account after its asynchronous guard was opened.
it("honors rejected draft guards and discards a navigation whose scope changed while waiting", async () => {
  vi.resetModules();
  const location = new URL("http://localhost/chat/original");
  const history = {
    state: {},
    replaceState: vi.fn((state: object, _title: string, path: string) => { history.state = state; location.href = new URL(path, location).href; }),
    pushState: vi.fn((state: object, _title: string, path: string) => { history.state = state; location.href = new URL(path, location).href; }),
    go: vi.fn(),
  };
  vi.stubGlobal("window", { location, history, addEventListener: vi.fn() });
  const { registerDesktopNavigationGuard, navigateDesktopRoute } = await import("../components/labs/lab-primary-tab-state");
  const removeReject = registerDesktopNavigationGuard(() => false);
  expect(await navigateDesktopRoute({ kind: "chat", sessionId: "target" })).toBe(false);
  expect(location.pathname).toBe("/chat/original");
  expect(history.pushState).not.toHaveBeenCalled();
  removeReject();
  let finish!: (accepted: boolean) => void;
  let current = true;
  const removeWaiting = registerDesktopNavigationGuard(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const waiting = navigateDesktopRoute({ kind: "chat", sessionId: "target" }, "push", () => current);
  current = false;
  finish(true);
  expect(await waiting).toBe(false);
  expect(history.pushState).not.toHaveBeenCalled();
  removeWaiting();
  current = true;
  expect(await navigateDesktopRoute({ kind: "chat", sessionId: "target" }, "push", () => current)).toBe(true);
  expect(location.pathname).toBe("/chat/target");
  expect(history.pushState).toHaveBeenCalledTimes(1);
});
