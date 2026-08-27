import { describe, expect, it } from "vitest";

import {
  desktopPath,
  desktopRouteFromLocation,
  modelProjectRoute,
  modelsPath,
  modelsRouteFromLocation,
  modelsSectionFromRoute,
} from "./lab-primary-tab-state";

describe("Models path routing", () => {
  it("parses canonical project, resource, and detail-tab paths", () => {
    expect(
      modelsRouteFromLocation({
        pathname: "/models/project_1/tasksets/taskset_1/scenarios",
      }),
    ).toEqual({
      kind: "project",
      projectId: "project_1",
      section: "tasksets",
      resourceId: "taskset_1",
      detailTab: "scenarios",
    });
    expect(
      modelsRouteFromLocation({ pathname: "/models/project_1/runs" }),
    ).toMatchObject({
      kind: "project",
      projectId: "project_1",
      section: "runs",
    });
    expect(
      modelsRouteFromLocation({ pathname: "/models/project_1/versions" }),
    ).toMatchObject({
      kind: "project",
      projectId: "project_1",
      section: "evals",
    });
    expect(
      modelsRouteFromLocation({
        pathname: "/models/project_1/runs/run_1/not-a-tab",
      }),
    ).toBeNull();
  });

  it("converts legacy query locations once without making them canonical", () => {
    expect(
      modelsRouteFromLocation({
        pathname: "/",
        search: "?modelProjectId=project_1&modelsTab=training",
      }),
    ).toMatchObject({
      kind: "project",
      projectId: "project_1",
      section: "runs",
    });
    expect(modelsRouteFromLocation({ pathname: "/models/runs" })).toBeNull();
  });

  it("serializes paths without query-string navigation state", () => {
    const route = modelProjectRoute("project with spaces", "evals");
    expect(modelsPath(route)).toBe("/models/project%20with%20spaces/evals");
    expect(modelsSectionFromRoute({ kind: "index" })).toBe("overview");
  });
});

describe("Settings and chat path routing", () => {
  it("parses canonical settings and chat paths", () => {
    expect(desktopRouteFromLocation({ pathname: "/settings/providers" })).toEqual({
      kind: "settings",
      section: "providers",
    });
    expect(desktopRouteFromLocation({ pathname: "/settings/unknown" })).toBeNull();
    expect(desktopRouteFromLocation({ pathname: "/chat/session%201" })).toEqual({
      kind: "chat",
      sessionId: "session 1",
    });
    expect(desktopRouteFromLocation({ pathname: "/chat/new" })).toEqual({
      kind: "chat",
      sessionId: null,
    });
  });

  it("serializes settings and chat paths without query strings", () => {
    expect(desktopPath({ kind: "settings", section: "dataset-storage" })).toBe(
      "/settings/dataset-storage",
    );
    expect(desktopPath({ kind: "chat", sessionId: "session 1" })).toBe(
      "/chat/session%201",
    );
    expect(desktopPath({ kind: "chat", sessionId: null })).toBe("/chat/new");
  });

  it("uses canonical paths for the other primary destinations", () => {
    expect(desktopRouteFromLocation({ pathname: "/apps" })).toEqual({
      kind: "view",
      view: "apps",
    });
    expect(desktopRouteFromLocation({ pathname: "/workflows" })).toEqual({
      kind: "view",
      view: "scheduled",
    });
    expect(desktopPath({ kind: "view", view: "outputs" })).toBe("/outputs");
    expect(desktopPath({ kind: "view", view: "projects" })).toBe("/projects");
  });
});
