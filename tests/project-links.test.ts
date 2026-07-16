import { describe, expect, test } from "vitest";
import type { LocalProject, OpenPondApp } from "@openpond/contracts";
import {
  currentOpenPondAppIds,
  currentOpenPondProjectLink,
  isLinkedToCurrentOpenPondApp,
} from "../apps/web/src/lib/project-links";

const currentApp: OpenPondApp = {
  id: "app_current",
  name: "Current App",
  description: null,
};

function project(linkedAppId: string | null): LocalProject {
  return {
    id: `project_${linkedAppId ?? "local"}`,
    name: "Local Project",
    path: "/tmp/local-project",
    workspacePath: "/tmp/local-project",
    repoPath: "/tmp/local-project",
    source: "git",
    linkedOpenPondApp: linkedAppId
      ? {
          appId: linkedAppId,
          appName: "Linked App",
          gitOwner: null,
          gitRepo: null,
          gitHost: null,
          defaultBranch: "main",
          linkedAt: "2026-05-16T00:00:00.000Z",
        }
      : null,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  };
}

describe("project OpenPond links", () => {
  test("treats a stored link as active only when the app is in the current account payload", () => {
    const appIds = currentOpenPondAppIds([currentApp]);
    const linkedProject = project("app_current");

    expect(currentOpenPondProjectLink(linkedProject, appIds)?.appId).toBe("app_current");
    expect(isLinkedToCurrentOpenPondApp(linkedProject, appIds)).toBe(true);
  });

  test("keeps projects visible when their stored link belongs to another account", () => {
    const appIds = currentOpenPondAppIds([currentApp]);
    const linkedProject = project("app_previous_account");

    expect(currentOpenPondProjectLink(linkedProject, appIds)).toBeNull();
    expect(isLinkedToCurrentOpenPondApp(linkedProject, appIds)).toBe(false);
  });

  test("handles plain local projects without an OpenPond link", () => {
    const appIds = currentOpenPondAppIds([currentApp]);
    const localProject = project(null);

    expect(currentOpenPondProjectLink(localProject, appIds)).toBeNull();
    expect(isLinkedToCurrentOpenPondApp(localProject, appIds)).toBe(false);
  });
});
