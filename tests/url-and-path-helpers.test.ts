import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";

import { hostedWebBaseUrl } from "../apps/server/src/openpond/saved-work";
import {
  defaultNewProjectDirectory,
  normalizeProjectDirectory,
} from "../apps/server/src/workspace/project-directories";
import { normalizeBrowserUrl } from "../apps/web/src/lib/browser-url";
import { absoluteLocalVideoPath, isLocalVideoPath } from "../apps/web/src/lib/local-video";
import {
  hybridWorkspaceSessionMetadata,
  isHybridWorkspaceSession,
  sessionWorkspaceLocation,
} from "../apps/web/src/lib/workspace-location";
import { normalizeSandboxApiUrl } from "../packages/cloud/src/sandbox/url.js";
import { defaultLocalProfileRepoPath } from "../packages/cloud/src/profile/local-profile";
import { isolatedOpenPondEnvironment } from "../scripts/isolated-openpond-environment";

const previousDocumentsDir = process.env.OPENPOND_APP_DOCUMENTS_DIR;

afterEach(() => {
  if (previousDocumentsDir === undefined) delete process.env.OPENPOND_APP_DOCUMENTS_DIR;
  else process.env.OPENPOND_APP_DOCUMENTS_DIR = previousDocumentsDir;
});

describe("URL normalization", () => {
  test("normalizes browser URLs while rejecting unsafe schemes", () => {
    expect(normalizeBrowserUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("file:///tmp/report.html")).toBeNull();
    expect(normalizeBrowserUrl("file:///tmp/report.html", { explicitFile: true })).toBe("file:///tmp/report.html");
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("not a url")).toBeNull();
  });

  test.each([
    ["https://api.openpond.ai", "https://api.openpond.ai/v1/sandboxes"],
    ["https://staging-api.openpond.ai", "https://staging-api.openpond.ai/v1/sandboxes"],
    ["https://api.staging-api.openpond.ai", "https://api.staging-api.openpond.ai/v1/sandboxes"],
  ])("normalizes sandbox API route %s", (input, expected) => {
    expect(normalizeSandboxApiUrl(input)).toBe(expected);
  });

  test("maps API hosts to the hosted app and honors an explicit origin", () => {
    expect(hostedWebBaseUrl({ OPENPOND_API_URL: "https://staging-api.openpond.ai" }))
      .toBe("https://staging.openpond.ai");
    expect(hostedWebBaseUrl({ OPENPOND_API_URL: "https://api.openpond.ai/v1" }))
      .toBe("https://openpond.ai");
    expect(hostedWebBaseUrl({ OPENPOND_HOSTED_WEB_URL: "https://preview.openpond.example/sandboxes" }))
      .toBe("https://preview.openpond.example");
  });
});

describe("local paths", () => {
  test("recognizes and resolves supported local video paths", () => {
    expect(isLocalVideoPath("/home/glu/Videos/demo.mp4")).toBe(true);
    expect(isLocalVideoPath("demo.webm")).toBe(true);
    expect(isLocalVideoPath("demo.png")).toBe(false);
    expect(absoluteLocalVideoPath("renders/demo.mp4", "/home/glu/project"))
      .toBe("/home/glu/project/renders/demo.mp4");
    expect(absoluteLocalVideoPath("/home/glu/Videos/demo.mp4", "/home/glu/project"))
      .toBe("/home/glu/Videos/demo.mp4");
  });

  test("uses the desktop Documents directory and normalizes user paths", () => {
    process.env.OPENPOND_APP_DOCUMENTS_DIR = path.join(os.tmpdir(), "OpenPond Docs");
    expect(defaultNewProjectDirectory()).toBe(
      path.join(os.tmpdir(), "OpenPond Docs", "OpenPond Projects"),
    );
    delete process.env.OPENPOND_APP_DOCUMENTS_DIR;
    expect(normalizeProjectDirectory(""))
      .toBe(path.join(os.homedir(), "Documents", "OpenPond Projects"));
    expect(normalizeProjectDirectory("~/Projects")).toBe(path.join(os.homedir(), "Projects"));
  });

  test("keeps isolated Profile state inside the app home", () => {
    const previousConfigDir = process.env.OPENPOND_CONFIG_DIR;
    const appHome = path.join(path.sep, "tmp", "openpond-harness");
    const configDir = path.join(appHome, "config");
    expect(isolatedOpenPondEnvironment(appHome)).toEqual({
      OPENPOND_APP_HOME: appHome,
      OPENPOND_CONFIG_DIR: configDir,
    });
    process.env.OPENPOND_CONFIG_DIR = configDir;
    try {
      expect(defaultLocalProfileRepoPath()).toBe(path.join(configDir, "profiles", "default-repo"));
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENPOND_CONFIG_DIR;
      else process.env.OPENPOND_CONFIG_DIR = previousConfigDir;
    }
  });

  test("marks hybrid sessions as sandbox-backed cloud sessions", () => {
    const session = {
      id: "session_1",
      provider: "codex",
      modelRef: null,
      title: "Hybrid",
      appId: null,
      appName: null,
      workspaceKind: "sandbox",
      workspaceId: null,
      workspaceName: "Hybrid workspace",
      localProjectId: "local_project_1",
      cloudProjectId: "cloud_project_1",
      cloudTeamId: "team_1",
      metadata: hybridWorkspaceSessionMetadata({ source: "test" }),
      cwd: "/workspace/project",
      codexThreadId: null,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
      status: "idle",
      pinned: false,
      archived: false,
      order: 0,
    } as Session;
    expect(session.metadata).toEqual({ source: "test", workspaceTarget: "hybrid" });
    expect(isHybridWorkspaceSession(session)).toBe(true);
    expect(sessionWorkspaceLocation(session)).toBe("cloud");
  });
});
