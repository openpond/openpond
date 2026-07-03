import { describe, expect, test } from "bun:test";
import {
  createOpenPondActionModelToolDefinitions,
  createOpenPondProfileSkillModelToolDefinitions,
  createResourceModelToolDefinitions,
  createWebSearchModelToolDefinition,
} from "../apps/server/src/openpond/model-tool-registry";
import type { Session } from "../packages/contracts/src";

describe("model tool registry", () => {
  test("maps sandbox resource search through sandbox_search_files", async () => {
    const payloads: unknown[] = [];
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        return {
          ok: true,
          action: "sandbox_search_files",
          output: "Found 1 sandbox file match.",
          data: {
            matches: [{ path: "/workspace/app/src/index.ts", line: 12, text: "inline image" }],
          },
        };
      },
    });
    const tool = definitions.find((definition) => definition.name === "resource_search");
    if (!tool) throw new Error("resource_search missing");

    const result = await tool.execute({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_1",
      args: { scope: "sandbox", query: "inline image", limit: 3 },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "find sandbox file",
    });

    expect(payloads).toEqual([
      {
        action: "sandbox_search_files",
        args: { query: "inline image", maxResults: 3 },
        source: "chat_action",
      },
    ]);
    expect(result.contentText).toContain("sandbox:file:/workspace/app/src/index.ts");
  });

  test("maps sandbox file resource reads through sandbox_read_file", async () => {
    const payloads: unknown[] = [];
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        return {
          ok: true,
          action: "sandbox_read_file",
          output: "Read file.",
          data: {
            file: {
              path: "/workspace/app/README.md",
              content: "# Sandbox README\n",
            },
          },
        };
      },
    });
    const tool = definitions.find((definition) => definition.name === "resource_read");
    if (!tool) throw new Error("resource_read missing");

    const result = await tool.execute({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_1",
      args: { ref: "sandbox:file:/workspace/app/README.md" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "read sandbox readme",
    });

    expect(payloads).toEqual([
      {
        action: "sandbox_read_file",
        args: { path: "/workspace/app/README.md" },
        source: "chat_action",
      },
    ]);
    expect(result.contentText).toContain("# Sandbox README");
    expect(result.contentText).toContain("sandbox:file:/workspace/app/README.md");
  });

  test("keeps binary sandbox file resources metadata-only", async () => {
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async () => ({
        ok: true,
        action: "sandbox_read_file",
        output: "Read pixel.png",
        data: {
          file: {
            path: "/workspace/app/pixel.png",
            contentsBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
            contentType: "image/png",
            binary: true,
            sizeBytes: 4,
          },
        },
      }),
    });
    const tool = definitions.find((definition) => definition.name === "resource_read");
    if (!tool) throw new Error("resource_read missing");

    const result = await tool.execute({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_1",
      args: { ref: "sandbox:file:/workspace/app/pixel.png" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "read sandbox image",
    });

    expect(result.contentText).toContain('"binary": true');
    expect(result.contentText).toContain('"reason": "binary"');
    expect(result.contentText).not.toContain("iVBOR");
  });

  test("surfaces sandbox resource failures instead of returning successful empty resources", async () => {
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => ({
        ok: false,
        action: (payload as any).action,
        output: "No active sandbox is attached to this chat.",
      }),
    });
    const search = definitions.find((definition) => definition.name === "resource_search");
    const read = definitions.find((definition) => definition.name === "resource_read");
    if (!search || !read) throw new Error("resource tools missing");

    await expect(
      search.execute({
        session: baseSession({ workspaceKind: "sandbox", workspaceId: null }),
        turnId: "turn_1",
        provider: "openrouter",
        model: "test/model",
        callId: "call_search",
        args: { scope: "sandbox", query: "README" },
        signal: new AbortController().signal,
        workspaceDiffBaseline: null,
        mentionedApps: [],
        userPrompt: "find sandbox file",
      }),
    ).rejects.toThrow("No active sandbox");
    await expect(
      read.execute({
        session: baseSession({ workspaceKind: "sandbox", workspaceId: null }),
        turnId: "turn_1",
        provider: "openrouter",
        model: "test/model",
        callId: "call_read",
        args: { ref: "sandbox:file:/workspace/app/README.md" },
        signal: new AbortController().signal,
        workspaceDiffBaseline: null,
        mentionedApps: [],
        userPrompt: "read sandbox file",
      }),
    ).rejects.toThrow("No active sandbox");
  });

  test("maps git resource search and reads through git workspace tools", async () => {
    const payloads: unknown[] = [];
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        if ((payload as any).action === "git_status") {
          return {
            ok: true,
            action: "git_status",
            output: "Workspace has 1 changed file.",
            data: {
              branch: "main",
              dirty: true,
              files: [{ path: "src/index.ts", status: "M" }],
            },
          };
        }
        return {
          ok: true,
          action: "git_diff",
          output: "Read working tree git diff.",
          data: {
            staged: false,
            diff: "diff --git a/src/index.ts b/src/index.ts\n",
          },
        };
      },
    });
    const search = definitions.find((definition) => definition.name === "resource_search");
    const read = definitions.find((definition) => definition.name === "resource_read");
    if (!search || !read) throw new Error("resource tools missing");

    const searchResult = await search.execute({
      session: baseSession({ workspaceKind: "local_project", workspaceId: "project_1" }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_search",
      args: { scope: "git", query: "diff" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "show git diff",
    });
    const statusResult = await read.execute({
      session: baseSession({ workspaceKind: "local_project", workspaceId: "project_1" }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_status",
      args: { ref: "git:status:working-tree" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "show git status",
    });
    const diffResult = await read.execute({
      session: baseSession({ workspaceKind: "local_project", workspaceId: "project_1" }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_diff",
      args: { ref: "git:diff:working-tree" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "show git diff",
    });

    expect(searchResult.contentText).toContain("git:diff:working-tree");
    expect(statusResult.contentText).toContain("workspace:file:src/index.ts");
    expect(diffResult.contentText).toContain("diff --git");
    expect(payloads).toEqual([
      { action: "git_status", args: {}, source: "chat_action" },
      { action: "git_diff", args: {}, source: "chat_action" },
    ]);
  });

  test("maps goal-context resources through current-session runtime events", async () => {
    const definitions = createResourceModelToolDefinitions({
      runtimeEvents: [
        {
          id: "goal_event",
          sessionId: "session_1",
          turnId: "turn_1",
          name: "diagnostic",
          timestamp: "2026-07-02T10:00:00.000Z",
          output: "Ship goal-context resources.",
          data: {
            kind: "thread_goal",
            goal: {
              id: "goal_1",
              objective: "Ship goal-context resources.",
              status: "active",
            },
          },
        },
      ],
      executeWorkspaceTool: async () => {
        throw new Error("goal-context resources should not use workspace tools");
      },
    });
    const search = definitions.find((definition) => definition.name === "resource_search");
    const read = definitions.find((definition) => definition.name === "resource_read");
    if (!search || !read) throw new Error("resource tools missing");

    const searchResult = await search.execute({
      session: baseSession(),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_search",
      args: { scope: "goal-context", query: "resources" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "read goal context",
    });
    const readResult = await read.execute({
      session: baseSession(),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_read",
      args: { ref: "goal-context:goal_event" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "read goal context",
    });

    const searchParameters = search.parameters as any;
    expect(searchParameters.properties.scope).toEqual(
      expect.objectContaining({
        enum: expect.arrayContaining(["goal-context"]),
      }),
    );
    expect(searchResult.contentText).toContain("goal-context:goal_event");
    expect(readResult.contentText).toContain("Ship goal-context resources");
  });

  test("validates scoped action ids and project/agent routing before running sandbox actions", async () => {
    const payloads: unknown[] = [];
    const definitions = createOpenPondActionModelToolDefinitions({
      actionCatalog: [
        {
          id: "deploy",
          name: "Deploy",
          sourceActionId: "deploy-prod",
          implementation: { type: "workflow", projectId: "project_1", agentId: "agent_1" },
        },
      ],
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        return {
          ok: true,
          action: "sandbox_run_action",
          output: "Ran deploy.",
          data: { status: "completed" },
        };
      },
    });
    const run = definitions.find((definition) => definition.name === "openpond_action_run");
    if (!run) throw new Error("openpond_action_run missing");

    await expect(run.execute(actionContext({ input: {} }))).rejects.toThrow("actionId is required");
    const unknown = await run.execute(actionContext({ actionId: "missing" }));
    const deniedProject = await run.execute(actionContext({ actionId: "deploy", projectId: "project_2" }));
    const deniedAgent = await run.execute(actionContext({ actionId: "deploy", agentId: "agent_2" }));
    const allowed = await run.execute(
      actionContext({
        actionId: "deploy",
        projectId: "project_1",
        agentId: "agent_1",
        input: { target: "prod" },
      }),
    );

    expect(unknown.ok).toBe(false);
    expect(unknown.contentText).toContain("not in the scoped allowed action catalog");
    expect(deniedProject.ok).toBe(false);
    expect(deniedProject.contentText).toContain("not authorized");
    expect(deniedAgent.ok).toBe(false);
    expect(deniedAgent.contentText).toContain("not authorized");
    expect(allowed.ok).toBe(true);
    expect(payloads).toEqual([
      {
        action: "sandbox_run_action",
        args: {
          actionName: "deploy-prod",
          input: { target: "prod" },
          projectId: "project_1",
          agentId: "agent_1",
        },
        source: "chat_action",
      },
    ]);
  });

  test("routes profile actions through the profile action executor", async () => {
    const profilePayloads: unknown[] = [];
    const definitions = createOpenPondActionModelToolDefinitions({
      actionCatalog: [
        {
          id: "profile.chat",
          label: "Profile Chat",
          implementation: { type: "openpond-profile-action", actionId: "chat" },
        },
      ],
      executeWorkspaceTool: async () => {
        throw new Error("profile actions should not use sandbox_run_action");
      },
      executeProfileAction: async (payload) => {
        profilePayloads.push(payload);
        return { action: "chat", stdout: "Profile answer", stderr: "", code: 0 };
      },
    });
    const run = definitions.find((definition) => definition.name === "openpond_action_run");
    if (!run) throw new Error("openpond_action_run missing");

    const result = await run.execute(actionContext({ actionId: "profile.chat", input: { prompt: "hello" } }));

    expect(result.ok).toBe(true);
    expect(result.contentText).toContain("Ran profile action chat");
    expect(profilePayloads).toEqual([
      {
        action: "chat",
        input: {
          prompt: "hello",
          message: "hello",
          source: "openpond_app",
        },
        metadata: {
          source: "openpond_app",
          selectedActionId: "chat",
          selectedActionLabel: "Profile Chat",
          selectedBy: "native_model_tool",
          displayPrompt: "run action",
          sessionId: "session_1",
        },
      },
    ]);
  });

  test("reads enabled profile skills through scoped model tool", async () => {
    const definitions = createOpenPondProfileSkillModelToolDefinitions({
      skills: [
        {
          name: "release-notes",
          description: "Draft release notes.",
          path: "skills/release-notes/SKILL.md",
          scope: "profile",
          enabled: true,
          sourcePath: "/tmp/profile/profiles/default",
          charCount: 120,
          sourceHash: "c".repeat(64),
          validationStatus: "valid",
          validationMessages: [],
        },
      ],
      readProfileSkill: async (name) => ({
        name,
        description: "Draft release notes.",
        body: "Write customer-facing release notes.",
        path: "skills/release-notes/SKILL.md",
        sourceHash: "c".repeat(64),
        charCount: 120,
      }),
    });
    const read = definitions.find((definition) => definition.name === "profile_skill_read");
    if (!read) throw new Error("profile_skill_read missing");

    const result = await read.execute(actionContext({ name: "release-notes" }));
    const missing = await read.execute(actionContext({ name: "missing" }));

    expect(result.ok).toBe(true);
    expect(result.contentText).toContain("Write customer-facing release notes.");
    expect(missing.ok).toBe(false);
    expect(missing.contentText).toContain("not in the active enabled skill catalog");
  });

  test("keeps full web search URLs in event data while hiding them from model-facing content", async () => {
    const tool = createWebSearchModelToolDefinition({
      executeWebSearch: async () => ({
        query: "USMNT July 1 2026",
        provider: "exa",
        searchedAt: "2026-07-03T00:00:00.000Z",
        truncated: false,
        results: [
          {
            id: "us-soccer",
            title: "USMNT match report",
            url: "https://www.ussoccer.com/stories/2026/07/usmnt-match-report",
            snippet: "Folarin Balogun and Malik Tillman scored.",
            sourceName: "U.S. Soccer",
            publishedAt: "2026-07-01T00:00:00.000Z",
            updatedAt: null,
          },
        ],
      }),
    });

    const result = await tool.execute(actionContext({ query: "USMNT July 1 2026", limit: 1 }));

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      result: {
        query: "USMNT July 1 2026",
        provider: "exa",
        searchedAt: "2026-07-03T00:00:00.000Z",
        truncated: false,
        results: [
          {
            id: "us-soccer",
            title: "USMNT match report",
            url: "https://www.ussoccer.com/stories/2026/07/usmnt-match-report",
            snippet: "Folarin Balogun and Malik Tillman scored.",
            sourceName: "U.S. Soccer",
            publishedAt: "2026-07-01T00:00:00.000Z",
            updatedAt: null,
          },
        ],
      },
    });
    expect(result.contentText).toContain("U.S. Soccer");
    expect(result.contentText).toContain("ussoccer.com");
    expect(result.contentText).not.toContain("https://www.ussoccer.com/stories/2026/07/usmnt-match-report");
  });
});

function actionContext(args: Record<string, unknown>) {
  return {
    session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
    turnId: "turn_1",
    provider: "openrouter" as const,
    model: "test/model",
    callId: "call_action",
    args,
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: "run action",
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "BYOK chat",
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
    createdAt: "2026-06-30T10:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
