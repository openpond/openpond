import { describe, expect, it } from "vitest";

import {
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
    const route = modelProjectRoute("project with spaces", "versions");
    expect(modelsPath(route)).toBe("/models/project%20with%20spaces/versions");
    expect(modelsSectionFromRoute({ kind: "index" })).toBe("overview");
  });
});
