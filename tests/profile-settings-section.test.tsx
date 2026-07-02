import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BootstrapPayload } from "@openpond/contracts";

import { ProfileSettingsSection } from "../apps/web/src/components/settings/ProfileSettingsSection";

const noop = () => undefined;
const NOW = "2026-06-30T12:00:00.000Z";

function profilePayload(): BootstrapPayload {
  return {
    preferences: {
      defaultTeamId: "team_1",
    },
    profile: {
      mode: "local",
      repoPath: "/workspace/openpond-profile",
      activeProfile: "default",
      sourcePath: "/workspace/openpond-profile/profiles/default",
      manifestPath: "profiles/default/openpond.yaml",
      agents: [
        {
          id: "agent_release_notes",
          name: "Release Notes",
          path: "profiles/default/agents/release-notes",
          enabled: true,
        },
      ],
      git: {
        isRepo: true,
        branch: "main",
        head: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
        shortHead: "f33a352",
        dirty: false,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        remoteUrl: "git@example.com:openpond/profile.git",
        files: [],
        error: null,
      },
      catalog: {
        actionCount: 1,
        generatedAt: NOW,
        manifestPath: "profiles/default/openpond.yaml",
        registryPath: "profiles/default/openpond-actions.json",
        stale: false,
        error: null,
      },
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [],
        },
      ],
      sourceSetupRequirements: [],
      setupGate: {
        status: "ready",
        requirementCount: 0,
        blockingCount: 0,
        optionalMissingCount: 0,
        readyCount: 0,
        requirements: [],
        blockingRequirements: [],
      },
      diff: {
        changedAgents: [],
        newAgents: [],
        deletedAgents: [],
        changedActions: [],
        changedExtensions: [],
        setupChanges: [],
        envRequirementChanges: [],
        files: [],
      },
      hosted: {
        teamId: "team_1",
        projectId: "project_profile",
        sourceRef: "main",
        sourceCommitSha: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
        lastPushedAt: NOW,
        lastPushedLocalHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
        lastPushedHostedHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
        promotionStatus: "uploaded",
        hostedRunStatus: "passed",
        localGoalId: null,
        hostedGoalId: null,
        hostedRunAgentId: null,
        hostedRunId: null,
        hostedRunAt: null,
      },
      summary: {
        state: "ready",
        message: "Profile ready.",
        agentCount: 1,
        actionCount: 1,
        defaultAction: "chat",
        checkFresh: true,
        checkStaleReason: null,
        localHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
        hostedHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
      },
      lastCheck: {
        command: "eval",
        status: "passed",
        checkedAt: NOW,
        exitCode: 0,
        sourceHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
      },
      error: null,
    },
    approvals: [
      {
        id: "approval_create_plan",
        sessionId: "session_release_notes",
        turnId: "turn_create_plan",
        providerRequestId: "request_1",
        kind: "create_plan",
        title: "Review release notes agent plan",
        detail: "Create plan review pending before source mutation.",
        status: "pending",
        createdAt: NOW,
      },
      {
        id: "approval_command",
        sessionId: "session_other",
        turnId: null,
        providerRequestId: "request_2",
        kind: "command",
        title: "Shell command approval",
        detail: "Not a create-plan review.",
        status: "pending",
        createdAt: NOW,
      },
    ],
  } as unknown as BootstrapPayload;
}

describe("ProfileSettingsSection", () => {
  test("renders profile create-plan review state from pending approvals", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileSettingsSection, {
        payload: profilePayload(),
        connection: null,
        onPayload: noop,
        onError: noop,
      }),
    );

    expect(html).toContain("Plan review");
    expect(html).toContain("1 pending");
    expect(html).toContain('aria-label="Pending profile plan reviews"');
    expect(html).toContain("Review release notes agent plan");
    expect(html).toContain("Create plan review pending before source mutation.");
    expect(html).toContain("session: session_release_notes");
    expect(html).toContain("turn: turn_create_plan");
    expect(html).not.toContain("Shell command approval");
  });
});
