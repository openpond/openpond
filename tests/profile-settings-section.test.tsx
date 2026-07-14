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
      skillCatalog: {
        skillCount: 0,
        generatedAt: null,
        stale: false,
        error: null,
      },
      skills: [],
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
        changedSkills: [],
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
        hostedSourceMaterialization: {
          status: "uploaded",
          agentId: "agent_release_notes",
          projectId: "project_profile",
          sourceCommitSha: "source_commit_release",
        },
        hostedSourceCheck: {
          status: "requested",
          agentId: "agent_release_notes",
          workItemId: "work_item_release",
          sandboxId: "sandbox_release",
        },
        hostedPublish: {
          status: "published",
          agentId: "agent_release_notes",
          snapshotId: "snapshot_release",
          manifestHash: "manifest_hash_release",
        },
        hostedRun: {
          status: "running",
          agentId: "agent_release_notes",
          runId: "run_release",
          runtimeId: "runtime_release",
        },
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
  test("renders summary metrics above the profile controls without the full summary card", () => {
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
    expect(html).toContain('aria-label="Profile summary"');
    expect(html).toContain("profile-summary-overview");
    expect(html).toContain("Action");
    expect(html).toContain("Check");
    expect(html).toContain("Synced");
    expect(html).toContain("Passed");
    expect(html).toContain("Commit");
    expect(html).toContain("Sync");
    expect(html).toContain("Repo");
    expect(html).not.toContain("<h1>Profile</h1>");
    expect(html).not.toContain('aria-label="Refresh profile"');
    expect(html).not.toContain(">Load<");
    expect(html).not.toContain("Checks passed");
    expect(html).not.toContain("Push hosted");
    expect(html).not.toContain("source-backed");
    expect(html).not.toContain("0 setup");
    expect(html).not.toContain("Profile repo path");
    expect(html).not.toContain("Commit message");
    expect(html).not.toContain("Confirm sync");
    expect(html).not.toContain("Shell command approval");
    expect(html).not.toContain("<span>Summary</span>");
    expect(html).not.toContain("Review release notes agent plan");

    const summaryIndex = html.indexOf('aria-label="Profile summary"');
    const detailsIndex = html.indexOf(">Details<");
    const commitIndex = html.indexOf(">Commit<");
    const syncIndex = html.indexOf(">Sync<");
    const repoIndex = html.indexOf(">Repo<");
    const agentsIndex = html.indexOf(
      'class="account-list-heading profile-agent-list-heading"><span>Agents</span>',
    );

    expect(summaryIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(-1);
    expect(repoIndex).toBeGreaterThan(-1);
    expect(agentsIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeLessThan(detailsIndex);
    expect(commitIndex).toBeLessThan(agentsIndex);
    expect(syncIndex).toBeLessThan(agentsIndex);
    expect(repoIndex).toBeLessThan(agentsIndex);
    expect(detailsIndex).toBeLessThan(agentsIndex);
  });

  test("renders profile skills beside profile agents", () => {
    const payload = profilePayload();
    payload.profile.skills = [
      {
        name: "release-notes",
        description: "Draft release notes from user-facing changes.",
        path: "skills/release-notes/SKILL.md",
        scope: "profile",
        enabled: true,
        sourcePath: "/workspace/openpond-profile/profiles/default",
        charCount: 240,
        sourceHash: "e".repeat(64),
        validationStatus: "valid",
        validationMessages: [],
      },
    ];
    payload.profile.skillCatalog = {
      skillCount: 1,
      generatedAt: NOW,
      stale: false,
      error: null,
    };

    const html = renderToStaticMarkup(
      createElement(ProfileSettingsSection, {
        payload,
        connection: null,
        onPayload: noop,
        onError: noop,
        onSkillCommand: noop,
      }),
    );

    expect(html).toContain("<span>Skills</span>");
    expect(html).toContain("release-notes");
    expect(html).toContain("Draft release notes from user-facing changes.");
    expect(html).toContain("skills/release-notes/SKILL.md");
    expect(html).toContain(">Use<");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Create<");
  });

  test("marks hosted profile sync as account-scoped when the default team changes", () => {
    const payload = profilePayload();
    payload.preferences.defaultTeamId = "team_2";

    const html = renderToStaticMarkup(
      createElement(ProfileSettingsSection, {
        payload,
        connection: null,
        onPayload: noop,
        onError: noop,
      }),
    );

    expect(html).toContain("Sync acct");
  });
});
