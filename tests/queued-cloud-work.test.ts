import { describe, expect, test } from "bun:test";

import { queuedCloudWorkSubmission } from "../apps/web/src/lib/queued-cloud-work";

describe("queued Cloud work submission", () => {
  test("builds a non-selecting Cloud work request for the armed one-shot target", () => {
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: "queue_cloud",
        actionSelected: false,
        promptOverrideProvided: false,
        attachmentCount: 0,
        selectedCloudProjectId: null,
        selectedProjectCloudProjectId: "cloud_project_1",
        selectedLocalProjectId: "local_project_1",
        selectedLocalProjectName: "Local Repo",
        selectedLocalWorkspacePath: "/workspace/local-repo",
        selectedProjectCloudSourceRef: "main",
        selectedProjectCloudBaseSha: "abc123",
        prompt: "  /create queue proof  ",
      }),
    ).toEqual({
      kind: "ready",
      request: {
        projectId: "cloud_project_1",
        prompt: "/create queue proof",
        select: false,
        localProjectId: "local_project_1",
        localProjectName: "Local Repo",
        localWorkspacePath: "/workspace/local-repo",
        sourceRef: "main",
        baseSha: "abc123",
        requestedExecutionTarget: "queue_cloud",
      },
    });
  });

  test("does not intercept normal sends, action sends, prompt overrides, attachments, or missing Cloud links", () => {
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: null,
        actionSelected: false,
        promptOverrideProvided: false,
        attachmentCount: 0,
        prompt: "local chat",
      }),
    ).toEqual({ kind: "not_queued" });
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: "hybrid",
        actionSelected: false,
        promptOverrideProvided: false,
        attachmentCount: 0,
        selectedProjectCloudProjectId: "cloud_project_1",
        prompt: "hybrid chat",
      }),
    ).toEqual({ kind: "not_queued" });
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: "queue_cloud",
        actionSelected: true,
        promptOverrideProvided: false,
        attachmentCount: 0,
        selectedProjectCloudProjectId: "cloud_project_1",
        prompt: "run action",
      }),
    ).toEqual({ kind: "not_queued" });
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: "queue_cloud",
        actionSelected: false,
        promptOverrideProvided: true,
        attachmentCount: 0,
        selectedProjectCloudProjectId: "cloud_project_1",
        prompt: "override",
      }),
    ).toEqual({ kind: "not_queued" });
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: "queue_cloud",
        actionSelected: false,
        promptOverrideProvided: false,
        attachmentCount: 1,
        selectedProjectCloudProjectId: "cloud_project_1",
        prompt: "with attachment",
      }),
    ).toMatchObject({ kind: "attachments_unsupported" });
    expect(
      queuedCloudWorkSubmission({
        pendingWorkspaceTarget: "queue_cloud",
        actionSelected: false,
        promptOverrideProvided: false,
        attachmentCount: 0,
        prompt: "missing cloud",
      }),
    ).toMatchObject({ kind: "missing_cloud_project" });
  });
});
