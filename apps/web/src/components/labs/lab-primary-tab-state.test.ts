import { describe, expect, it } from "vitest";
import {
  changeModelsScope, desktopPath, desktopRouteFromLocation, MODELS_PAGES, modelsLocation,
  modelsPath, modelsRouteFromLocation, settingsReturnRoute,
} from "./lab-primary-tab-state";

describe("Models page, scope and resource route boundary", () => {
  // Changing model scope must retain the active page while clearing its old detail.
  it("round-trips every page and retains compatible views while clearing the previous model's detail", () => {
    for (const page of MODELS_PAGES) {
      const original = modelsLocation(page, "model A");
      const url = new URL(modelsPath(original), "https://local.invalid");
      expect(url.searchParams.has("model")).toBe(false);
      if (["datasets", "graders", "experiments"].includes(page)) expect(url.pathname).toBe(`/models/${page}`);
      else if (page !== "get-started") expect(url.pathname).toContain("/models/model%20A");
      expect(modelsRouteFromLocation(url)).toEqual(original);
      expect(changeModelsScope(original, "model B")).toEqual(modelsLocation(page, "model B"));
      expect(changeModelsScope(original, null)).toEqual(modelsLocation(page));
    }
    for (const page of ["datasets", "graders", "experiments"] as const) {
      const scoped = modelsLocation(page, "model A", { projectId: "project A", resourceId: "resource A" });
      expect(scoped.modelId).toBeNull();
      const consoleRoute = { ...scoped, area: "console" as const };
      expect(modelsPath(consoleRoute)).toMatch(/^\/console\//);
      expect(desktopRouteFromLocation(new URL(modelsPath(consoleRoute), "https://local.invalid"))).toEqual({ kind: "models", route: consoleRoute });
      expect(modelsRouteFromLocation(new URL(modelsPath(scoped), "https://local.invalid"))).toEqual(scoped);
      expect(changeModelsScope(scoped, "model B")).toEqual(modelsLocation(page, null, { projectId: "project A" }));
      expect(modelsRouteFromLocation({ pathname: `/models/model-a/${page}` })).toBeNull();
      expect(modelsRouteFromLocation({ pathname: `/models/${page}`, search: "?model=model-a" })).toBeNull();
    }
    const review = modelsLocation("evaluations", "model A", { collection: "review", sourceId: "source/A", resourceId: "evidence-a", after: "cursor-1" });
    expect(modelsRouteFromLocation(new URL(modelsPath(review), "https://local.invalid"))).toEqual(review);
    expect(changeModelsScope(review, "model B").sourceId).toBeUndefined();
    expect(modelsRouteFromLocation({ pathname: "/models/evaluations/review", search: "?source=a&source=b" })).toBeNull();
    expect(modelsRouteFromLocation({ pathname: "/models/runs", search: "?source=a" })).toBeNull();
    const run = modelsLocation("runs", "model A", { collection: "series", resourceId: "series/with slash", detailTab: "entry:1", query: "recent", after: "cursor-1" });
    expect(modelsRouteFromLocation(new URL(modelsPath(run), "https://local.invalid"))).toEqual(run);
    expect(changeModelsScope(run, "model B")).toEqual(modelsLocation("runs", "model B", { collection: "series" }));
    expect(modelsRouteFromLocation({ pathname: "/models" })).toEqual(modelsLocation());
  });

  // Regression: ambiguous execution IDs and retired paths silently selected the wrong resource or project.
  it("preserves typed resource identities and reserves creation and series routes", () => {
    const history = modelsLocation("experiments", null, { area: "console", collection: "history", projectId: "project A", after: "run-cursor" });
    expect(modelsRouteFromLocation(new URL(modelsPath(history), "https://local.invalid"))).toEqual(history);
    expect(modelsRouteFromLocation({ pathname: "/console/experiments/history/extra" })).toBeNull();
    // An imported release keeps its ordinary Dataset ID while selecting the
    // immutable reader; the marker must not spill into other resource routes.
    const releasedDataset = modelsLocation("datasets", null, { area: "console", resourceId: "hosted-dataset/A", datasetKind: "release", detailTab: "tasks" });
    expect(modelsRouteFromLocation(new URL(modelsPath(releasedDataset), "https://local.invalid"))).toEqual(releasedDataset);
    expect(modelsRouteFromLocation({ pathname: "/console/graders/g", search: "?dataset=release" })).toBeNull();
    expect(modelsRouteFromLocation({ pathname: "/console/datasets", search: "?dataset=release" })).toBeNull();
    for (const ref of ["model-run:same", "job:same", "reward-run:same"]) {
      const route = modelsLocation("runs", null, { resourceId: ref, detailTab: "metrics" });
      expect(modelsRouteFromLocation(new URL(modelsPath(route), "https://local.invalid"))).toEqual(route);
    }
    expect(modelsRouteFromLocation({ pathname: "/models/runs/new/model-a", search: "?model=model-a" })).toEqual(modelsLocation("runs", "model-a", { collection: "new", resourceId: "model-a" }));
    expect(modelsRouteFromLocation({ pathname: "/models/tasksets/drafts/draft-a" })).toEqual(modelsLocation("tasksets", null, { collection: "drafts", resourceId: "draft-a" }));
    expect(modelsRouteFromLocation({ pathname: "/models/project-a/tasksets" })).toEqual(modelsLocation("tasksets", "project-a"));
    expect(modelsRouteFromLocation({ pathname: "/models/project-a/tasks", search: "?model=other" })).toBeNull();
    for (const pathname of ["/models/get-started/private-model", "/models/projects/project-a", "/models/scorers", "/models/runs/new", "/models/versions/version-a/lineage", "/models/evaluations/not-a-view/anything", "/models/tasksets/t/graders", "/models/tasksets/%ZZ"]) expect(modelsRouteFromLocation({ pathname })).toBeNull();
    for (const search of ["?model=a", "?q=invoice", "?after=old-workspace-cursor"]) {
      expect(modelsRouteFromLocation({ pathname: "/models/get-started", search })).toBeNull();
    }
    expect(modelsRouteFromLocation({ pathname: "/models", search: "?model=a&model=b" })).toBeNull();
    expect(modelsRouteFromLocation({ pathname: "/models", search: "?modelProjectId=old&modelsTab=training" })).toBeNull();
  });
});

describe("Settings and other Desktop destinations", () => {
  // Regression: configuring a provider discarded the originating run draft and returned to new chat.
  it("carries a bounded canonical Models return location without allowing external redirects", () => {
    const consoleReturn = modelsPath(modelsLocation("experiments", null, { area: "console", projectId: "project A", resourceId: "exp A" }));
    expect(settingsReturnRoute({ kind: "settings", section: "providers", returnTo: consoleReturn })).toEqual({ kind: "models", route: modelsLocation("experiments", null, { area: "console", projectId: "project A", resourceId: "exp A" }) });
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
