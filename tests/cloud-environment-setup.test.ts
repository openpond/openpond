import { describe, expect, test } from "bun:test";

import {
  buildCloudProjectCreateUrl,
  buildCloudProjectUrl,
  buildCloudEnvironmentCreateUrl,
  CLOUD_CODING_RUNTIME_PROFILE_ID,
  CLOUD_CODING_WORKFLOW_MODE,
} from "../apps/web/src/lib/cloud-environment-setup";

describe("Cloud environment setup", () => {
  test("builds a prefilled sandbox create URL for Cloud coding", () => {
    const url = new URL(
      buildCloudEnvironmentCreateUrl({
        accountBaseUrl: "https://staging.openpond.ai/dashboard",
        teamId: "team_openpond",
        projectId: "project_water",
        projectName: "Water Estimator",
        baseBranch: "main",
        localProjectId: "local_project_water",
        source: "openpond-app",
      }),
    );

    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      "https://staging.openpond.ai/sandboxes",
    );
    expect(url.searchParams.get("teamId")).toBe("team_openpond");
    expect(url.searchParams.get("create")).toBe("sandbox");
    expect(url.searchParams.get("intent")).toBe("cloud-coding");
    expect(url.searchParams.get("source")).toBe("openpond-app");
    expect(url.searchParams.get("projectId")).toBe("project_water");
    expect(url.searchParams.get("workflowMode")).toBe(CLOUD_CODING_WORKFLOW_MODE);
    expect(url.searchParams.get("runtimeProfileId")).toBe(
      CLOUD_CODING_RUNTIME_PROFILE_ID,
    );
    expect(url.searchParams.get("projectName")).toBe("Water Estimator");
    expect(url.searchParams.get("baseBranch")).toBe("main");
    expect(url.searchParams.get("localProjectId")).toBe("local_project_water");
  });

  test("builds a Cloud Project create URL for hosted source import handoff", () => {
    const url = new URL(
      buildCloudProjectCreateUrl({
        accountBaseUrl: "https://staging.openpond.ai/settings",
        teamId: "team_openpond",
        source: "template",
      }),
    );

    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      "https://staging.openpond.ai/sandboxes/projects",
    );
    expect(url.searchParams.get("teamId")).toBe("team_openpond");
    expect(url.searchParams.get("create")).toBe("project");
    expect(url.searchParams.get("source")).toBe("template");
  });

  test("builds the Cloud Project page URL from organization and project slugs", () => {
    expect(
      buildCloudProjectUrl({
        accountBaseUrl: "https://staging.openpond.ai/settings",
        organizationSlug: "openpond",
        projectSlug: "water-estimator",
      }),
    ).toBe("https://staging.openpond.ai/openpond/water-estimator");
  });

  test("does not build a broken Cloud Project page URL without slugs", () => {
    expect(
      buildCloudProjectUrl({
        accountBaseUrl: "https://staging.openpond.ai",
        organizationSlug: "openpond",
        projectSlug: null,
      }),
    ).toBeNull();
  });

  test("falls back to the production web origin for invalid account URLs", () => {
    const url = new URL(
      buildCloudEnvironmentCreateUrl({
        accountBaseUrl: "not a url",
        teamId: "team_openpond",
        projectId: "project_empty",
        source: "openpond-app",
      }),
    );

    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      "https://openpond.ai/sandboxes",
    );
    expect(url.searchParams.get("runtimeProfileId")).toBe(
      "openpond-coding-core-v1",
    );
  });
});
