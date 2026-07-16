import { describe, expect, test } from "vitest";
import type { LocalProject, Session } from "@openpond/contracts";
import {
  buildSidebarProjectPathIndex,
  isSidebarCloudWorkSession,
  sidebarProjectIdForSession,
} from "../apps/web/src/lib/sidebar-session-projects";

const timestamp = "2026-05-28T00:00:00.000Z";

function project(overrides: Partial<LocalProject>): LocalProject {
  return {
    id: "project_1",
    name: "Project",
    path: "/tmp/project",
    workspacePath: "/tmp/project",
    repoPath: "/tmp/project",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "session_1",
    provider: "codex",
    title: "Thread",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    cwd: "/tmp/project",
    codexThreadId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

function resolve(sessionInput: Session, projects: LocalProject[]): string | null {
  return sidebarProjectIdForSession(
    sessionInput,
    new Set(projects.map((item) => item.id)),
    buildSidebarProjectPathIndex(projects),
  );
}

describe("sidebar session project inference", () => {
  test("keeps explicitly bound local project sessions under their stored project", () => {
    const projects = [project({ id: "project_1" })];

    expect(
      resolve(
        session({
          workspaceKind: "local_project",
          workspaceId: "project_1",
          cwd: "/some/other/path",
        }),
        projects,
      ),
    ).toBe("project_1");
  });

  test("infers general Codex sessions from cwd inside a project folder", () => {
    const projects = [project({ id: "project_1", repoPath: "/tmp/project" })];

    expect(resolve(session({ cwd: "/tmp/project/apps/web" }), projects)).toBe("project_1");
  });

  test("uses the most specific project when folders are nested", () => {
    const projects = [
      project({ id: "parent", repoPath: "/tmp/project", path: "/tmp/project", workspacePath: "/tmp/project" }),
      project({
        id: "child",
        repoPath: "/tmp/project",
        path: "/tmp/project/apps/web",
        workspacePath: "/tmp/project/apps/web",
      }),
    ];

    expect(resolve(session({ cwd: "/tmp/project/apps/web/src" }), projects)).toBe("child");
    expect(resolve(session({ cwd: "/tmp/project/packages/api" }), projects)).toBe("parent");
  });

  test("infers non-Codex local sessions from cwd", () => {
    const projects = [project({ id: "project_1" })];

    expect(resolve(session({ provider: "openai", cwd: "/tmp/project" }), projects)).toBe("project_1");
  });

  test("does not infer sandbox app sessions from cwd", () => {
    const projects = [project({ id: "project_1" })];

    expect(
      resolve(
        session({
          provider: "openpond",
          workspaceKind: "sandbox_app",
          cwd: "/tmp/project",
        }),
        projects,
      ),
    ).toBeNull();
  });

  test("keeps Cloud workspace sessions out of sidebar project children", () => {
    const projects = [project({ id: "project_1" })];
    const cloudIds = new Set(["cloud_project_1"]);
    const input = session({
      provider: "openpond",
      workspaceKind: "sandbox",
      workspaceId: "sandbox_1",
      cloudProjectId: "cloud_project_1",
      cwd: null,
    });

    expect(isSidebarCloudWorkSession(input, cloudIds)).toBe(true);
    expect(
      sidebarProjectIdForSession(
        input,
        new Set(projects.map((item) => item.id)),
        buildSidebarProjectPathIndex(projects),
        cloudIds,
      ),
    ).toBeNull();
  });

  test("keeps Hybrid sandbox sessions under the local project inferred from cwd", () => {
    const projects = [project({ id: "project_1" })];
    const cloudIds = new Set(["cloud_project_1"]);
    const input = session({
      provider: "zai",
      workspaceKind: "sandbox",
      workspaceId: "sandbox_1",
      cloudProjectId: "cloud_project_1",
      cwd: "/tmp/project",
      metadata: { workspaceTarget: "hybrid" },
    });

    expect(isSidebarCloudWorkSession(input, cloudIds)).toBe(false);
    expect(
      sidebarProjectIdForSession(
        input,
        new Set(projects.map((item) => item.id)),
        buildSidebarProjectPathIndex(projects),
        cloudIds,
      ),
    ).toBe("project_1");
  });

  test("matches Windows project paths case-insensitively", () => {
    const projects = [
      project({
        id: "windows",
        path: "C:\\Users\\me\\Code\\Project",
        workspacePath: "C:\\Users\\me\\Code\\Project",
        repoPath: "C:\\Users\\me\\Code\\Project",
      }),
    ];

    expect(resolve(session({ cwd: "c:\\users\\me\\code\\project\\src" }), projects)).toBe("windows");
  });
});
