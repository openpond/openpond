import path from "node:path";

import { describe, expect, test } from "vitest";
import { createLocalActionRunner } from "openpond-sdk/actions/local";

import { loadAnalyticsDashboard } from "../examples/project-actions-analytics/apps/web/analytics";

const projectRoot = path.resolve(import.meta.dirname, "../examples/project-actions-analytics");

describe("Project Actions analytics proof Project", () => {
  test("returns the same typed result to the website and local Work runner", async () => {
    const websiteResult = loadAnalyticsDashboard("relocation");
    const workResult = await createLocalActionRunner({ projectRoot, build: "always" }).run({
      actionId: "analytics.get_summary",
      input: { businessId: "relocation" },
    });

    expect(workResult.output).toEqual(websiteResult);
    expect(workResult.traces).toEqual([
      expect.objectContaining({
        name: "analytics.loaded",
        payload: { businessId: "relocation" },
      }),
    ]);
  });
});
