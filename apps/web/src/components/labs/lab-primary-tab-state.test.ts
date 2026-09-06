import { describe, expect, it } from "vitest";
import {
  changeModelsScope, desktopPath, desktopRouteFromLocation, MODELS_PAGES, modelsLocation,
  modelsPath, modelsRouteFromLocation, settingsReturnRoute,
} from "./lab-primary-tab-state";

describe("Models page, scope and resource route boundary", () => {
  // Regression: scope was encoded as a separate page tree, and changing models discarded the active page.
  it("round-trips every page and retains compatible views while clearing the previous model's detail", () => {
    for (const page of MODELS_PAGES) {
      const original = modelsLocation(page, "model A");
      const url = new URL(modelsPath(original), "https://local.invalid");
      expect(modelsRouteFromLocation(url)).toEqual(original);
      expect(changeModelsScope(original, "model B")).toEqual(modelsLocation(page, "model B"));
      expect(changeModelsScope(original, null)).toEqual(modelsLocation(page));
    }
    const run = modelsLocation("runs", "model A", { collection: "series", resourceId: "series/with slash", detailTab: "entry:1", query: "recent", after: "cursor-1" });
    expect(modelsRouteFromLocation(new URL(modelsPath(run), "https://local.invalid"))).toEqual(run);
    expect(changeModelsScope(run, "model B")).toEqual(modelsLocation("runs", "model B", { collection: "series" }));
    expect(modelsRouteFromLocation({ pathname: "/models" })).toEqual(modelsLocation());
  });

  // Regression: ambiguous execution IDs and retired paths silently selected the wrong resource or project.
  it("preserves typed resource identities and reserves creation and series routes", () => {
    for (const ref of ["model-run:same", "job:same", "reward-run:same"]) {
      const route = modelsLocation("runs", null, { resourceId: ref, detailTab: "metrics" });
      expect(modelsRouteFromLocation(new URL(modelsPath(route), "https://local.invalid"))).toEqual(route);
    }
    expect(modelsRouteFromLocation({ pathname: "/models/runs/new/model-a", search: "?model=model-a" })).toEqual(modelsLocation("runs", "model-a", { collection: "new", resourceId: "model-a" }));
    expect(modelsRouteFromLocation({ pathname: "/models/tasksets/drafts/draft-a" })).toEqual(modelsLocation("tasksets", null, { collection: "drafts", resourceId: "draft-a" }));
    for (const pathname of ["/models/project-a/tasksets", "/models/projects/project-a", "/models/scorers", "/models/runs/new", "/models/versions/version-a/lineage", "/models/evaluations/not-a-view/anything", "/models/tasksets/t/graders", "/models/tasksets/%ZZ"]) expect(modelsRouteFromLocation({ pathname })).toBeNull();
    expect(modelsRouteFromLocation({ pathname: "/models", search: "?model=a&model=b" })).toBeNull();
    expect(modelsRouteFromLocation({ pathname: "/models", search: "?modelProjectId=old&modelsTab=training" })).toBeNull();
  });
});

describe("Settings and other Desktop destinations", () => {
  // Regression: configuring a provider discarded the originating run draft and returned to new chat.
  it("carries a bounded canonical Models return location without allowing external redirects", () => {
    const origin = modelsLocation("tasksets", "model-a", { collection: "drafts", resourceId: "draft-a" });
    const settings = { kind: "settings" as const, section: "providers" as const, returnTo: modelsPath(origin) };
    const location = new URL(desktopPath(settings), "https://local.invalid");
    const parsed = desktopRouteFromLocation(location);
    expect(parsed).toEqual(settings);
    expect(settingsReturnRoute(parsed)).toEqual({ kind: "models", route: origin });
    expect(settingsReturnRoute({ ...settings, returnTo: "//attacker.invalid/models" })).toEqual({ kind: "chat", sessionId: null });
    expect(desktopRouteFromLocation({ pathname: "/settings/unknown" })).toBeNull();
    expect(desktopPath({ kind: "view", view: "scheduled" })).toBe("/workflows");
    expect(desktopRouteFromLocation({ pathname: "/chat/session%201" })).toEqual({ kind: "chat", sessionId: "session 1" });
  });
});
