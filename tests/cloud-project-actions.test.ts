import { afterEach, describe, expect, test } from "vitest";
import type { BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection } from "../apps/web/src/api";
import { useProjectActions } from "../apps/web/src/hooks/useProjectActions";
import type { OpenPondOrganization } from "../apps/web/src/lib/organization-types";

const connection: ClientConnection = {
  serverUrl: "http://127.0.0.1:17874",
  token: "test-token",
  platform: "test",
};

const ownerOrganization: OpenPondOrganization = {
  teamId: "team_owner",
  slug: "owner",
  name: "Owner",
  displayName: "Owner Team",
  role: "owner",
  status: "active",
  primaryContactEmail: null,
  customDomain: null,
  createdAt: "2026-06-16T00:00:00.000Z",
  updatedAt: "2026-06-16T00:00:00.000Z",
};

const originalApi = {
  organizations: api.organizations,
  upsertSandboxProject: api.upsertSandboxProject,
  uploadSandboxProjectSource: api.uploadSandboxProjectSource,
  bootstrap: api.bootstrap,
};

afterEach(() => {
  api.organizations = originalApi.organizations;
  api.upsertSandboxProject = originalApi.upsertSandboxProject;
  api.uploadSandboxProjectSource = originalApi.uploadSandboxProjectSource;
  api.bootstrap = originalApi.bootstrap;
});

function applyState<T>(current: T, next: T | ((previous: T) => T)): T {
  return typeof next === "function" ? (next as (previous: T) => T)(current) : next;
}

function cloudProject(input: Record<string, unknown> = {}) {
  return {
    id: "project_1",
    teamId: ownerOrganization.teamId,
    name: "Cloud Project",
    slug: "cloud-project",
    status: "active",
    sourceType: "internal_repo",
    normalizedSourceIdentity: "cloud-project",
    internalRepoPath: "cloud-project",
    defaultBranch: "main",
    sourceConfig: {},
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    archivedAt: null,
    ...input,
  };
}

function createHarness(defaultTeamId: string | null = ownerOrganization.teamId) {
  let error: string | null = null;
  let selectedProjectId: string | null = null;
  let selectedAppId: string | null = "app_1";
  let selectedSessionId: string | null = "session_1";
  let view = "chat";
  let expandedProjectIds = new Set<string>();
  const toasts: Array<{ message: string; tone?: string }> = [];
  const expanded: string[] = [];
  const payloads: BootstrapPayload[] = [];

  const actions = useProjectActions({
    connection,
    defaultTeamId,
    sessions: [],
    selectedProjectId,
    applyBootstrapPayload: (payload) => payloads.push(payload),
    expandProject: (projectId) => expanded.push(projectId),
    revealProjectsSection: () => {},
    setExpandedProjectIds: (next) => {
      expandedProjectIds = applyState(expandedProjectIds, next);
    },
    setSelectedAppId: (next) => {
      selectedAppId = applyState(selectedAppId, next);
    },
    setSelectedProjectId: (next) => {
      selectedProjectId = applyState(selectedProjectId, next);
    },
    setSelectedSessionId: (next) => {
      selectedSessionId = applyState(selectedSessionId, next);
    },
    setError: (next) => {
      error = applyState(error, next);
    },
    setView: (next) => {
      view = applyState(view, next);
    },
    showToast: (message, tone) => {
      toasts.push({ message, tone });
    },
  });

  return {
    actions,
    state: () => ({ error, selectedAppId, selectedProjectId, selectedSessionId, view, expanded, expandedProjectIds, payloads, toasts }),
  };
}

function stubOrganizations(organizations: OpenPondOrganization[]) {
  api.organizations = async () => ({ organizations });
}

describe("Cloud Project actions", () => {
  test("requires an OpenPond account before creating a Cloud Project", async () => {
    stubOrganizations([]);
    api.upsertSandboxProject = async () => {
      throw new Error("unexpected project upsert");
    };

    const harness = createHarness(null);

    await expect(harness.actions.createCloudProjectFromScratch("Docs")).resolves.toBe(false);
    expect(harness.state().error).toBe("Add an OpenPond account before creating a Cloud Project.");
    expect(harness.state().toasts.at(-1)).toEqual({
      message: "Add an OpenPond account before creating a Cloud Project.",
      tone: "error",
    });
  });

  test("requires owner or admin access before creating a Cloud Project", async () => {
    stubOrganizations([{ ...ownerOrganization, role: "member" }]);
    api.upsertSandboxProject = async () => {
      throw new Error("unexpected project upsert");
    };

    const harness = createHarness(ownerOrganization.teamId);

    await expect(harness.actions.createCloudProjectFromScratch("Docs")).resolves.toBe(false);
    expect(harness.state().error).toBe("You need owner or admin access to create projects in Owner Team.");
    expect(harness.state().toasts.at(-1)).toEqual({
      message: "You need owner or admin access to create projects in Owner Team.",
      tone: "error",
    });
  });

  test("surfaces project upsert failures with the specific message", async () => {
    stubOrganizations([ownerOrganization]);
    api.upsertSandboxProject = async () => {
      throw new Error("project upsert failed");
    };

    const harness = createHarness();

    await expect(harness.actions.createCloudProjectFromScratch("Docs")).resolves.toBe(false);
    expect(harness.state().error).toBe("project upsert failed");
    expect(harness.state().toasts.at(-1)).toEqual({ message: "project upsert failed", tone: "error" });
  });

  test("surfaces source upload failures with the specific message", async () => {
    stubOrganizations([ownerOrganization]);
    api.upsertSandboxProject = async () => ({ project: cloudProject() } as never);
    api.uploadSandboxProjectSource = async () => {
      throw new Error("source upload failed");
    };

    const harness = createHarness();

    await expect(harness.actions.createCloudProjectFromScratch("Docs")).resolves.toBe(false);
    expect(harness.state().error).toBe("source upload failed");
    expect(harness.state().toasts.at(-1)).toEqual({ message: "source upload failed", tone: "error" });
  });

  test("creates a plain README-only Cloud Project without requiring openpond.yaml", async () => {
    stubOrganizations([ownerOrganization]);
    const createdProject = cloudProject({ name: "Docs" });
    let uploadInput: { entries?: Array<{ path: string; contentsBase64?: string }> } | null = null;

    api.upsertSandboxProject = async () => ({ project: createdProject } as never);
    api.uploadSandboxProjectSource = async (_connection, _projectId, input) => {
      uploadInput = input;
      return { project: createdProject } as never;
    };
    api.bootstrap = async () => ({ sessions: [], projects: [], apps: [] } as never);

    const harness = createHarness();

    await expect(harness.actions.createCloudProjectFromScratch("Docs")).resolves.toBe(true);
    expect(uploadInput?.entries?.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(uploadInput?.entries?.some((entry) => entry.path === "openpond.yaml")).toBe(false);
    expect(harness.state().selectedProjectId).toBe("cloud:project_1");
    expect(harness.state().toasts.at(-1)).toEqual({ message: "Created Cloud Project: Docs", tone: "success" });
  });
});
