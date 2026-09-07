import { expect, it, vi } from "vitest";

// Repeated Back while a draft decision is pending used to invalidate the first
// destination; Discard closed the form without completing the requested move.
it("preserves one draft decision and its original history destination", async () => {
  vi.resetModules();
  const events = new EventTarget();
  const entries = [{ url: new URL("https://app.invalid/models"), state: {} as Record<string, unknown> }];
  let index = 0;
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: Record<string, unknown>, _unused: string, path: string) {
      entries.splice(index + 1);
      entries.push({ url: new URL(path, entries[index]!.url), state });
      index++;
    },
    replaceState(state: Record<string, unknown>, _unused: string, path?: string) {
      entries[index] = { url: path ? new URL(path, entries[index]!.url) : entries[index]!.url, state };
    },
    go(delta: number) {
      queueMicrotask(() => {
        const target = index + delta;
        if (target < 0 || target >= entries.length) return;
        index = target;
        events.dispatchEvent(new Event("popstate"));
      });
    },
  };
  vi.stubGlobal("window", {
    get location() { return entries[index]!.url; }, history,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const routes = await import("./lab-primary-tab-state");
    await routes.navigateModelsRoute(routes.modelsLocation("tasksets"));
    await routes.navigateModelsRoute(routes.modelsLocation("models"));
    await routes.navigateModelsRoute(routes.modelsLocation("get-started"));
    let resolveDecision: (allowed: boolean) => void = () => { throw new Error("No pending decision"); };
    const destinations: string[] = [];
    const unregister = routes.registerDesktopNavigationGuard(path => new Promise(resolve => { destinations.push(path); resolveDecision = resolve; }));
    history.go(-1);
    await settle();
    expect(window.location.pathname).toBe("/models/get-started");
    history.go(-1);
    await settle();
    expect(destinations).toEqual(["/models"]);
    expect(window.location.pathname).toBe("/models/get-started");
    resolveDecision(false);
    await settle();
    expect(window.location.pathname).toBe("/models/get-started");
    history.go(-1);
    await settle();
    history.go(-1);
    await settle();
    resolveDecision(true);
    await settle();
    expect(destinations).toEqual(["/models", "/models"]);
    expect(window.location.pathname).toBe("/models");
    unregister();
  } finally { vi.unstubAllGlobals(); }
});
