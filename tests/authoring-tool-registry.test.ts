import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  emptyOpenPondProfileState,
  type OpenPondProfileRef,
  type Session,
} from "../packages/contracts/src";
import { createAuthoringModelToolDefinitions } from "../apps/server/src/openpond/authoring-tool-registry";
import type { ModelToolExecutionContext } from "../apps/server/src/openpond/model-tool-registry";

describe("normal-turn authoring tools", () => {
  test("registers narrow question, Profile, and Agent SDK operations without authoring executors", () => {
    const names = createAuthoringModelToolDefinitions({
      loadProfileState: async () => emptyOpenPondProfileState(),
    }).map((definition) => definition.name);

    expect(names).toEqual([
      "ask_user",
      "get_profile",
      "agent_inspect",
      "agent_build",
      "agent_validate",
      "agent_eval",
      "agent_run",
      "agent_traces",
      "agent_check",
    ]);
    expect(names).not.toEqual(expect.arrayContaining([
      "create_skill",
      "edit_skill",
      "create_agent",
      "improve_agent",
      "openpond_create_improve",
      "openpond_profile_skill_goal",
    ]));
  });

  test("get_profile reloads the immutable turn-selected Profile ref", async () => {
    const selectedRef: OpenPondProfileRef = {
      source: "local",
      repositoryId: "profile-repo",
      profileId: "selected",
    };
    const receivedRefs: Array<OpenPondProfileRef | null | undefined> = [];
    const definition = requireTool(createAuthoringModelToolDefinitions({
      loadProfileState: async (ref) => {
        receivedRefs.push(ref);
        return {
          ...emptyOpenPondProfileState(),
          mode: "local",
          activeProfile: "selected",
          repoPath: "/profiles/profile-repo",
          sourcePath: "/profiles/profile-repo/profiles/selected",
          manifestPath: "/profiles/profile-repo/openpond-profile.json",
        };
      },
    }), "get_profile");

    const result = await definition.execute(context({}, {
      authoringIntent: {
        artifact: "skill",
        operation: "create",
        objective: "Draft release notes.",
        targetSkillName: null,
      },
      selectedProfileRef: selectedRef,
    }));

    expect(receivedRefs).toEqual([selectedRef]);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      editable: true,
      activeProfile: "selected",
      repoPath: "/profiles/profile-repo",
      sourcePath: "/profiles/profile-repo/profiles/selected",
      ref: selectedRef,
    });
    expect(JSON.stringify(result.data)).not.toContain("process.env");
  });

  test("ask_user returns terminal normal-turn control and structured question data", async () => {
    const definition = requireTool(
      createAuthoringModelToolDefinitions({}),
      "ask_user",
    );
    const result = await definition.execute(context({
      question: "Which output contract should this Agent expose?",
      reason: "The choice changes its public action schema.",
      options: [
        { id: "markdown", label: "Markdown" },
        { id: "json", label: "JSON" },
      ],
      allowFreeform: false,
    }));

    expect(result.ok).toBe(true);
    expect(result.turnControl).toBe("await_user_input");
    expect(result.data).toMatchObject({
      question: "Which output contract should this Agent expose?",
      status: "awaiting_user_input",
      nextStep: "end_turn",
      allowFreeform: false,
    });
  });

  test("rejects Agent SDK targets whose canonical source escapes the selected Profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-agent-tool-boundary-"));
    try {
      const profileSourcePath = path.join(root, "profile");
      const outsidePath = path.join(root, "outside-agent");
      await mkdir(path.join(profileSourcePath, "agents"), { recursive: true });
      await mkdir(outsidePath, { recursive: true });
      await symlink(outsidePath, path.join(profileSourcePath, "agents", "escape"));
      const definition = requireTool(createAuthoringModelToolDefinitions({
        loadProfileState: async () => ({
          ...emptyOpenPondProfileState(),
          mode: "local",
          activeProfile: "selected",
          repoPath: root,
          sourcePath: profileSourcePath,
          agents: [{ id: "escape", enabled: true }] as any,
        }),
      }), "agent_inspect");

      await expect(definition.execute(context({ agentId: "escape" })))
        .rejects.toThrow("Profile Agent source escapes the selected Profile: escape");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds Improve tools to the exact Agent ID in turn metadata", async () => {
    const definition = requireTool(createAuthoringModelToolDefinitions({
      loadProfileState: async () => ({
        ...emptyOpenPondProfileState(),
        mode: "local",
        activeProfile: "selected",
        repoPath: "/profiles/repo",
        sourcePath: "/profiles/repo/profiles/selected",
        agents: [{ id: "other-agent", enabled: true }] as any,
      }),
    }), "agent_validate");

    await expect(definition.execute(context(
      { agentId: "other-agent" },
      {
        authoringIntent: {
          artifact: "agent",
          operation: "improve",
          objective: "Tighten responses.",
          targetAgentId: "target-agent",
        },
      },
    ))).rejects.toThrow("Agent improve is bound to target-agent");
  });
});

function requireTool(
  definitions: ReturnType<typeof createAuthoringModelToolDefinitions>,
  name: string,
) {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing tool definition: ${name}`);
  return definition;
}

function context(
  args: Record<string, unknown>,
  turnMetadata: Record<string, unknown> = {},
): ModelToolExecutionContext {
  return {
    session: baseSession(),
    turnId: "turn_1",
    turnPermissions: {
      approvalPolicy: null,
      sandbox: null,
      codexPermissionMode: null,
      codexReasoningEffort: null,
    },
    provider: "openrouter",
    model: "test/model",
    callId: "call_1",
    args,
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: "Create the requested artifact.",
    turnMetadata,
  };
}

function baseSession(): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "Authoring chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
