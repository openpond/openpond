import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SandboxProjectWorkspaceResponse } from "../../lib/sandbox-types";
import {
  ProjectDeploymentsTab,
  ProjectEnvironmentsTab,
  ProjectRequestsTab,
  ProjectWebsiteTab,
} from "./ProjectWorkspaceTabs";

const workspace = {
  project: { metadata: { preferredDevelopmentSandboxId: "sandbox-1" } },
  environments: [{
    sandbox: {
      id: "sandbox-1",
      state: "running",
      repoRef: "main",
      metadata: { name: "Development" },
      updatedAt: "2026-08-25T12:00:00.000Z",
    },
    runtime: { baseBranch: "main" },
  }],
  deployments: [{
    release: {
      id: "release-1",
      version: 3,
      status: "active",
      sourceCommitSha: "abcdef1234567890",
      failureCode: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      readyAt: "2026-08-25T12:02:00.000Z",
      activatedAt: "2026-08-25T12:03:00.000Z",
    },
    build: {
      id: "build-1",
      attemptNumber: 1,
      status: "succeeded",
      currentStage: "ready",
      failureCode: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      completedAt: "2026-08-25T12:02:00.000Z",
    },
    creatorName: "Ada",
  }],
  requests: [{
    id: "trace-1",
    releaseId: "release-1",
    startedAt: "2026-08-25T12:04:00.000Z",
    method: "GET",
    path: "/ingress/health",
    outcome: "success",
    responseStatus: 200,
    coldStart: false,
    totalDurationMs: 42,
    stages: [],
  }],
  website: {
    settings: {
      appId: "app-1",
      projectId: "project-1",
      platformDomain: "example.openpond.app",
      status: "active",
      activeReleaseId: "release-1",
      runtimePolicy: { availabilityMode: "always_on" },
    },
    releases: [{
      id: "release-1",
      version: 3,
      status: "active",
      sourceCommitSha: "abcdef1234567890",
      failureCode: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      readyAt: "2026-08-25T12:02:00.000Z",
      activatedAt: "2026-08-25T12:03:00.000Z",
    }],
  },
  database: { status: "ready", provider: "neon", errorCode: null },
  errors: { website: null, database: null, deployments: null, requests: null },
} as unknown as SandboxProjectWorkspaceResponse;

const common = { linked: true, loading: false, unavailable: false, workspace };

describe("project workspace tabs", () => {
  it("renders environment and deployment records", () => {
    const environments = renderToStaticMarkup(<ProjectEnvironmentsTab {...common} />);
    const deployments = renderToStaticMarkup(<ProjectDeploymentsTab {...common} />);
    expect(environments).toContain("Development");
    expect(environments).toContain("Preferred");
    expect(deployments).toContain("v3");
    expect(deployments).toContain("Ada");
  });

  it("renders request and Website state", () => {
    const requests = renderToStaticMarkup(<ProjectRequestsTab {...common} />);
    const website = renderToStaticMarkup(<ProjectWebsiteTab {...common} />);
    expect(requests).toContain("GET");
    expect(requests).toContain("/api/health");
    expect(website).toContain("example.openpond.app");
    expect(website).toContain("Connected · neon");
    expect(website).toContain("Always on");
  });
});
