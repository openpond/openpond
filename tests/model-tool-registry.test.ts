import { describe, expect, test } from "vitest";
import {
  createCommandModelToolDefinition,
  createConnectedAppSkillModelToolDefinitions,
  createOpenPondActionModelToolDefinitions,
  createOpenPondProfileSkillModelToolDefinitions,
  createResourceModelToolDefinitions,
  createWebFetchModelToolDefinition,
  createWebSearchModelToolDefinition,
} from "../apps/server/src/openpond/model-tool-registry";
import {
  createBrowserModelToolDefinitions,
  redactBrowserToolArguments,
  type BrowserHarnessToolName,
  type BrowserHarnessToolExecutor,
} from "../apps/server/src/openpond/browser-tool-registry";
import {
  connectedAppProviderToolNames,
  createConnectedAppProviderModelToolDefinitions,
  redactConnectedAppToolArguments,
} from "../apps/server/src/openpond/connected-app-tool-registry";
import type { ResolvedConnectedAppContext } from "../apps/server/src/openpond/connected-app-context";
import type { Session } from "../packages/contracts/src";

describe("model tool registry", () => {
  test("gates browser model tools on desktop executor availability", () => {
    const availableExecutor = browserExecutor({ available: true });
    const unavailableExecutor = browserExecutor({ available: false });
    const none = createBrowserModelToolDefinitions(null);
    const available = createBrowserModelToolDefinitions(availableExecutor);
    const unavailable = createBrowserModelToolDefinitions(unavailableExecutor);

    expect(none).toEqual([]);
    expect(available.map((definition) => definition.name)).toEqual([
      "openpond_browser_open",
      "openpond_browser_snapshot",
      "openpond_browser_move_cursor",
      "openpond_browser_click",
      "openpond_browser_type",
      "openpond_browser_key",
      "openpond_browser_scroll",
    ]);
    expect(
      available.filter((definition) =>
        definition.enabled?.({
          session: baseSession(),
          provider: "openrouter",
          model: "test/model",
          mentionedApps: [],
        }) ?? true
      ).map((definition) => definition.name),
    ).toContain("openpond_browser_click");
    expect(
      unavailable.filter((definition) =>
        definition.enabled?.({
          session: baseSession(),
          provider: "openrouter",
          model: "test/model",
          mentionedApps: [],
        }) ?? true
      ),
    ).toEqual([]);
  });

  test("maps browser tool inputs through the harness executor and redacts sensitive args", async () => {
    const calls: unknown[] = [];
    const definitions = createBrowserModelToolDefinitions(browserExecutor({
      available: true,
      calls,
    }));
    const click = definitions.find((definition) => definition.name === "openpond_browser_click");
    const type = definitions.find((definition) => definition.name === "openpond_browser_type");
    if (!click || !type) throw new Error("browser tools missing");

    const clickResult = await click.execute(actionContext({
      snapshotId: "snap_1",
      targetRef: "target_2",
      button: "left",
      clickCount: 1,
    }));
    const typeResult = await type.execute(actionContext({
      snapshotId: "snap_1",
      targetRef: "input_1",
      text: "secret typed value",
    }));

    expect(clickResult.ok).toBe(true);
    expect(typeResult.ok).toBe(true);
    expect(calls).toEqual([
      {
        method: "click",
        target: { kind: "ref", snapshotId: "snap_1", targetRef: "target_2" },
        button: "left",
        clickCount: 1,
      },
      {
        method: "typeText",
        target: { kind: "ref", snapshotId: "snap_1", targetRef: "input_1" },
        textLength: 18,
      },
    ]);

    expect(redactBrowserToolArguments("openpond_browser_type", {
      text: "secret typed value",
      snapshotId: "snap_1",
      targetRef: "input_1",
    })).toEqual({
      text: "[redacted 18 chars]",
      snapshotId: "snap_1",
      targetRef: "input_1",
    });
    expect(redactBrowserToolArguments("openpond_browser_open", {
      url: "https://example.com/path?token=secret#auth",
    })).toEqual({
      url: "https://example.com/path?[redacted]#[redacted]",
    });
  });

  test("rejects malformed browser targets before they reach the executor", async () => {
    const calls: unknown[] = [];
    const definitions = createBrowserModelToolDefinitions(browserExecutor({
      available: true,
      calls,
    }));
    const click = definitions.find((definition) => definition.name === "openpond_browser_click");
    if (!click) throw new Error("openpond_browser_click missing");

    await expect(click.execute(actionContext({ targetRef: "target_without_snapshot" }))).rejects.toThrow(
      "targetRef requires snapshotId",
    );
    await expect(click.execute(actionContext({ snapshotId: "snap_1", targetRef: "target_1", x: 10, y: 20 }))).rejects.toThrow(
      "provide either targetRef/snapshotId or x/y",
    );
    expect(calls).toEqual([]);
  });

  test("keeps browser observation and workspace mutation routed separately in Hybrid harness", async () => {
    const browserCalls: unknown[] = [];
    const workspacePayloads: unknown[] = [];
    let profileActionCalled = false;
    const hybridSession = baseSession({
      provider: "openrouter",
      workspaceKind: "sandbox",
      workspaceId: "sandbox_hybrid",
      workspaceName: "Hybrid Sandbox",
      localProjectId: "local_project_1",
      cloudProjectId: "cloud_project_1",
      cloudTeamId: "team_1",
      metadata: { workspaceTarget: "hybrid" },
    });
    const browserDefinitions = createBrowserModelToolDefinitions(browserExecutor({
      available: true,
      calls: browserCalls,
    }));
    const resourceDefinitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        workspacePayloads.push(payload);
        const action = (payload as any).action;
        return {
          ok: true,
          action,
          output: action === "sandbox_exec" ? "fixture validation passed" : "Edited README.md.",
          data: action === "sandbox_exec"
            ? { command: { status: "succeeded", output: "fixture validation passed" } }
            : { edit: { path: "README.md", replacements: 1, verified: true } },
        };
      },
    });
    const actionDefinitions = createOpenPondActionModelToolDefinitions({
      actionCatalog: [
        {
          id: "profile.chat",
          label: "Profile Chat",
          implementation: { type: "openpond-profile-action", actionId: "chat" },
        },
      ],
      executeWorkspaceTool: async () => {
        throw new Error("profile actions should not become sandbox actions");
      },
      executeProfileAction: async () => {
        profileActionCalled = true;
        throw new Error("profile action should not run in Hybrid");
      },
    });
    const snapshot = browserDefinitions.find((definition) => definition.name === "openpond_browser_snapshot");
    const edit = resourceDefinitions.find((definition) => definition.name === "sandbox_edit_file");
    const exec = resourceDefinitions.find((definition) => definition.name === "sandbox_exec");
    const actionRun = actionDefinitions.find((definition) => definition.name === "openpond_action_run");
    if (!snapshot || !edit || !exec || !actionRun) throw new Error("Hybrid harness tools missing");

    const snapshotResult = await snapshot.execute({
      ...actionContext({ maxTargets: 8 }),
      session: hybridSession,
    });
    const editResult = await edit.execute({
      ...actionContext({
        path: "README.md",
        oldText: "before",
        newText: "after",
      }),
      session: hybridSession,
    });
    const execResult = await exec.execute({
      ...actionContext({ command: "pnpm typecheck" }),
      session: hybridSession,
    });
    const localOnlyResult = await actionRun.execute({
      ...actionContext({
        actionId: "profile.chat",
        input: { prompt: "hello" },
      }),
      session: hybridSession,
    });

    expect(snapshotResult.ok).toBe(true);
    expect(editResult.ok).toBe(true);
    expect(execResult.ok).toBe(true);
    expect(localOnlyResult.ok).toBe(false);
    expect(localOnlyResult.contentText).toContain("Working in Hybrid");
    expect(profileActionCalled).toBe(false);
    expect(browserCalls).toEqual([{ method: "snapshot", maxTargets: 8 }]);
    expect(workspacePayloads).toEqual([
      {
        action: "sandbox_edit_file",
        args: { path: "README.md", oldText: "before", newText: "after" },
        source: "chat_action",
      },
      {
        action: "sandbox_exec",
        args: { command: "pnpm typecheck" },
        source: "chat_action",
      },
    ]);
  });

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

  test("maps workspace resource search to sandbox search under sandbox execution target", async () => {
    const payloads: unknown[] = [];
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        return {
          ok: true,
          action: "sandbox_search_files",
          output: "Found 1 sandbox file match.",
          data: {
            matches: [{ path: "README.md", line: 1, text: "Hybrid README" }],
          },
        };
      },
    });
    const tool = definitions.find((definition) => definition.name === "resource_search");
    if (!tool) throw new Error("resource_search missing");

    const result = await tool.execute({
      session: baseSession({
        workspaceKind: "sandbox",
        workspaceId: "sandbox_1",
        metadata: { workspaceTarget: "hybrid" },
      }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_1",
      args: { scope: "workspace", query: "README" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "find readme",
    });

    expect(payloads).toEqual([
      {
        action: "sandbox_search_files",
        args: { query: "README" },
        source: "chat_action",
      },
    ]);
    expect(result.contentText).toContain("sandbox:file:README.md");
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

  test("maps workspace file refs to sandbox reads under sandbox execution target", async () => {
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
              path: "README.md",
              content: "# Hybrid README\n",
            },
          },
        };
      },
    });
    const tool = definitions.find((definition) => definition.name === "resource_read");
    if (!tool) throw new Error("resource_read missing");

    const result = await tool.execute({
      session: baseSession({
        workspaceKind: "sandbox",
        workspaceId: "sandbox_1",
        metadata: { workspaceTarget: "hybrid" },
      }),
      turnId: "turn_1",
      provider: "openrouter",
      model: "test/model",
      callId: "call_1",
      args: { ref: "workspace:file:README.md" },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "read readme",
    });

    expect(payloads).toEqual([
      {
        action: "sandbox_read_file",
        args: { path: "README.md" },
        source: "chat_action",
      },
    ]);
    expect(result.contentText).toContain("# Hybrid README");
    expect(result.contentText).toContain("sandbox:file:README.md");
  });

  test("maps sandbox native write and edit tools through sandbox workspace actions", async () => {
    const payloads: unknown[] = [];
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        const action = (payload as any).action;
        return {
          ok: true,
          action,
          output: action === "sandbox_edit_file" ? "Edited README.md with 1 replacement." : "Wrote README.md.",
          data: action === "sandbox_edit_file"
            ? { edit: { path: "README.md", replacements: 1, verified: true } }
            : { file: { path: "README.md" } },
        };
      },
    });
    const write = definitions.find((definition) => definition.name === "sandbox_write_file");
    const edit = definitions.find((definition) => definition.name === "sandbox_edit_file");
    if (!write || !edit) throw new Error("sandbox write/edit tools missing");

    expect(write.enabled?.({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(true);
    expect(write.enabled?.({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: null }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(false);

    const writeResult = await write.execute(actionContext({
      path: "README.md",
      content: "# Updated\n",
    }));
    const editResult = await edit.execute(actionContext({
      path: "README.md",
      oldText: "# Old\n",
      newText: "# New\n",
      replaceAll: false,
    }));

    expect(payloads).toEqual([
      {
        action: "sandbox_write_file",
        args: { path: "README.md", content: "# Updated\n" },
        source: "chat_action",
      },
      {
        action: "sandbox_edit_file",
        args: { path: "README.md", oldText: "# Old\n", newText: "# New\n", replaceAll: false },
        source: "chat_action",
      },
    ]);
    expect(writeResult.contentText).toContain("Wrote README.md.");
    expect(editResult.contentText).toContain("Edited README.md");
  });

  test("maps sandbox native command and git tools through sandbox workspace actions", async () => {
    const payloads: unknown[] = [];
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        payloads.push(payload);
        const action = (payload as any).action;
        return {
          ok: true,
          action,
          output:
            action === "sandbox_exec"
              ? "Command succeeded\n\nfixture validation passed"
              : action === "sandbox_git_status"
                ? "Sandbox git status has 1 changed file."
                : action === "sandbox_git_diff"
                  ? "diff --git a/README.md b/README.md"
                  : "Sandbox is running.",
          data:
            action === "sandbox_exec"
              ? { command: { status: "succeeded", output: "fixture validation passed" } }
              : action === "sandbox_git_status"
                ? { status: { files: [{ path: "README.md", status: "M" }] } }
                : action === "sandbox_git_diff"
                  ? { diff: "diff --git a/README.md b/README.md" }
                  : { sandbox: { id: "sandbox_1", state: "running" } },
        };
      },
    });
    const status = definitions.find((definition) => definition.name === "sandbox_status");
    const exec = definitions.find((definition) => definition.name === "sandbox_exec");
    const gitStatus = definitions.find((definition) => definition.name === "sandbox_git_status");
    const gitDiff = definitions.find((definition) => definition.name === "sandbox_git_diff");
    if (!status || !exec || !gitStatus || !gitDiff) throw new Error("sandbox command/git tools missing");

    expect(exec.enabled?.({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(true);
    expect(exec.enabled?.({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: null }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(false);

    const statusResult = await status.execute(actionContext({}));
    const execResult = await exec.execute(actionContext({ command: "pnpm typecheck", timeoutSeconds: 180 }));
    const gitStatusResult = await gitStatus.execute(actionContext({}));
    const gitDiffResult = await gitDiff.execute(actionContext({ baseRef: "HEAD" }));

    expect(payloads).toEqual([
      {
        action: "sandbox_status",
        args: {},
        source: "chat_action",
      },
      {
        action: "sandbox_exec",
        args: { command: "pnpm typecheck", timeoutSeconds: 180 },
        source: "chat_action",
      },
      {
        action: "sandbox_git_status",
        args: {},
        source: "chat_action",
      },
      {
        action: "sandbox_git_diff",
        args: { baseRef: "HEAD" },
        source: "chat_action",
      },
    ]);
    expect(statusResult.contentText).toContain("Sandbox is running.");
    expect(execResult.contentText).toContain("fixture validation passed");
    expect(gitStatusResult.contentText).toContain("Sandbox git status has 1 changed file.");
    expect(gitDiffResult.contentText).toContain("diff --git");
  });

  test("gates OpenPond exec_command to non-Codex, non-sandbox sessions", async () => {
    const tool = createCommandModelToolDefinition({
      executeCommand: async (input) => ({
        ok: true,
        command: input.command,
        cwd: input.cwd ?? input.session.cwd,
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
        timedOut: false,
        timeoutSeconds: 120,
        truncated: false,
        blockedReason: null,
      }),
    });

    expect(tool.enabled?.({
      session: baseSession({
        provider: "openrouter",
        workspaceKind: "local_project",
        workspaceId: "project_1",
        cwd: "/tmp/project",
        openPondCommandAccessMode: "ask",
      }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(true);
    expect(tool.enabled?.({
      session: baseSession({
        provider: "openrouter",
        workspaceKind: undefined,
        workspaceId: null,
        localProjectId: null,
        cwd: null,
        openPondCommandAccessMode: "full-access",
      }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(true);
    expect(tool.enabled?.({
      session: baseSession({
        provider: "openrouter",
        workspaceKind: undefined,
        workspaceId: null,
        localProjectId: null,
        cwd: "/tmp/cwd-only",
        openPondCommandAccessMode: "ask",
      }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(true);
    expect(tool.enabled?.({
      session: baseSession({
        provider: "codex",
        workspaceKind: "local_project",
        workspaceId: "project_1",
        cwd: "/tmp/project",
        openPondCommandAccessMode: "ask",
      }),
      provider: "codex",
      model: "codex",
      mentionedApps: [],
    })).toBe(false);
    expect(tool.enabled?.({
      session: baseSession({
        provider: "openrouter",
        workspaceKind: "local_project",
        workspaceId: "project_1",
        cwd: "/tmp/project",
        openPondCommandAccessMode: "disabled",
      }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(false);
    expect(tool.enabled?.({
      session: baseSession({
        provider: "openrouter",
        workspaceKind: "sandbox",
        workspaceId: "sandbox_1",
        cwd: "/tmp/project",
        openPondCommandAccessMode: "ask",
      }),
      provider: "openrouter",
      model: "test/model",
      mentionedApps: [],
    })).toBe(false);
  });

  test("maps OpenPond exec_command model calls through command access service", async () => {
    const calls: unknown[] = [];
    const tool = createCommandModelToolDefinition({
      executeCommand: async (input) => {
        calls.push(input);
        return {
          ok: true,
          command: input.command,
          cwd: input.cwd ?? input.session.cwd,
          exitCode: 0,
          stdout: "hello\n",
          stderr: "",
          timedOut: false,
          timeoutSeconds: 5,
          truncated: false,
          blockedReason: null,
        };
      },
    });

    const result = await tool.execute(actionContext(
      { command: "printf hello", cwd: "/tmp/project", timeoutSeconds: 5 },
      {
        provider: "openrouter",
        workspaceKind: "local_project",
        workspaceId: "project_1",
        cwd: "/tmp/project",
        openPondCommandAccessMode: "full-access",
      },
    ));

    expect(result.ok).toBe(true);
    expect(result.name).toBe("exec_command");
    expect(result.contentText).toContain("Command completed successfully.");
    expect(result.data).toMatchObject({
      command: "printf hello",
      cwd: "/tmp/project",
      stdout: "hello\n",
      exitCode: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "printf hello",
      cwd: "/tmp/project",
      timeoutSeconds: 5,
      source: "model_tool",
    });
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

  test("maps git changed-file refs to sandbox refs for sandbox sessions", async () => {
    const definitions = createResourceModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => ({
        ok: true,
        action: (payload as any).action,
        output: "Sandbox git status has 1 changed file.",
        data: {
          status: {
            files: [{ path: "README.md", status: "M" }],
          },
        },
      }),
    });
    const read = definitions.find((definition) => definition.name === "resource_read");
    if (!read) throw new Error("resource_read missing");

    const result = await read.execute({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
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

    expect(result.contentText).toContain("sandbox:file:README.md");
    expect(result.contentText).not.toContain("workspace:file:README.md");
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

    const result = await run.execute({
      ...actionContext({ actionId: "profile.chat", input: { prompt: "hello" } }),
      session: baseSession({
        workspaceKind: "local_project",
        workspaceId: "local_project_1",
        cwd: "/tmp/profile-workspace",
      }),
    });

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

  test("fails closed for profile actions in Hybrid sessions", async () => {
    let profileActionCalled = false;
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
      executeProfileAction: async () => {
        profileActionCalled = true;
        throw new Error("profile action should not run in Hybrid");
      },
    });
    const run = definitions.find((definition) => definition.name === "openpond_action_run");
    if (!run) throw new Error("openpond_action_run missing");

    const result = await run.execute(
      actionContext(
        {
          actionId: "profile.chat",
          input: { prompt: "hello" },
        },
        {
          metadata: { workspaceTarget: "hybrid" },
          localProjectId: "local_project_1",
          cloudProjectId: "cloud_project_1",
          cloudTeamId: "team_1",
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.contentText).toContain("local profile action");
    expect(result.contentText).toContain("Working in Hybrid");
    expect(profileActionCalled).toBe(false);
  });

  test("reads connected app integration instructions through scoped model tool", async () => {
    const definitions = createConnectedAppSkillModelToolDefinitions({
      connectedApps: [{ provider: "google", label: "Google" }],
    });
    const read = definitions.find((definition) => definition.name === "connected_app_skill_read");
    if (!read) throw new Error("connected_app_skill_read missing");

    const result = await read.execute(actionContext({ provider: "google" }));
    const missing = await read.execute(actionContext({ provider: "x" }));

    expect(result.ok).toBe(true);
    expect(result.contentText).toContain("Google Connected App");
    expect(result.contentText).toContain("server-provided connected app tools");
    expect(result.contentText).not.toContain("refresh_token");
    expect(result.data).toMatchObject({
      skill: {
        provider: "google",
        name: "google-connected-app",
        path: "integration_skills/google.md",
      },
    });
    expect(missing.ok).toBe(false);
    expect(missing.contentText).toContain("not available in this turn");
  });

  test("scopes connected app provider tools to resolved providers and capabilities", async () => {
    const definitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [googleConnectedAppContext(), mcpConnectedAppContext()],
    });
    const search = definitions.find((definition) => definition.name === "connected_app_search");
    const read = definitions.find((definition) => definition.name === "connected_app_read");
    const write = definitions.find((definition) => definition.name === "connected_app_write");
    if (!search || !read || !write) throw new Error("connected app provider tools missing");

    expect(connectedAppProviderToolNames(googleConnectedAppContext())).toEqual([
      "connected_app_search",
      "connected_app_read",
      "connected_app_write",
    ]);
    expect(connectedAppProviderToolNames(mcpConnectedAppContext())).toEqual([]);
    expect((search.parameters as any).properties.provider.enum).toEqual(["google"]);

    const missing = await search.execute(actionContext({ provider: "x", query: "mentions" }));
    const deniedCapability = await search.execute(
      actionContext({
        provider: "google",
        query: "budget",
        capabilityIds: ["google.admin.secret"],
      }),
    );
    const unavailable = await read.execute(actionContext({ provider: "google", ref: "google:file:1" }));

    expect(missing.ok).toBe(false);
    expect(missing.contentText).toContain("not available in this turn");
    expect(deniedCapability.ok).toBe(false);
    expect(deniedCapability.contentText).toContain("not authorized");
    expect(unavailable.ok).toBe(false);
    expect(unavailable.contentText).toContain("No provider API call was made");
    expect(unavailable.contentText).not.toContain("conn_google");
  });

  test("redacts connected app provider tool arguments and executor results", async () => {
    const executorRequests: unknown[] = [];
    const definitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [googleConnectedAppContext()],
      executeConnectedAppTool: async (request) => {
        executorRequests.push(request);
        return {
          ok: true,
          output: "Found 1 Drive result.",
          data: {
            items: [
              {
                ref: "google:file:budget",
                title: "Budget",
                accessToken: "provider-token",
                connectionId: "conn_google",
              },
            ],
          },
        };
      },
    });
    const search = definitions.find((definition) => definition.name === "connected_app_search");
    if (!search) throw new Error("connected_app_search missing");

    const result = await search.execute(
      actionContext({
        provider: "google",
        query: "budget",
        authorization: "Bearer provider-token",
        capabilityIds: ["google.drive.file.read"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(executorRequests).toMatchObject([
      {
        provider: "google",
        operation: "search",
        connectionIds: ["conn_google"],
        capabilityIds: ["google.drive.file.read"],
        args: {
          provider: "google",
          query: "budget",
          authorization: "[redacted]",
        },
      },
    ]);
    expect(result.contentText).toContain("Budget");
    expect(result.contentText).not.toContain("provider-token");
    expect(result.contentText).not.toContain("conn_google");
    expect(JSON.stringify(result.data)).not.toContain("provider-token");
    expect(JSON.stringify(result.data)).not.toContain("conn_google");
    expect(redactConnectedAppToolArguments("connected_app_read", { refreshToken: "secret" })).toEqual({
      refreshToken: "[redacted]",
    });
  });

  test("surfaces provider HTTP errors from connected app tool calls", async () => {
    const definitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [xConnectedAppContext()],
      executeConnectedAppTool: async () => ({
        ok: false,
        output: "Connected app operation x.search.posts was denied.",
        data: {
          provider: "x",
          operation: "search",
          operationId: "x.search.posts",
          capability: "x.tweets.search.recent",
          status: "error",
          result: {
            detail: "credits depleted",
            status: 402,
            title: "Payment Required",
            type: "https://api.x.com/2/problems/credits-depleted",
          },
          metadata: {
            provider: "x",
            httpStatus: 402,
          },
        },
      }),
    });
    const search = definitions.find((definition) => definition.name === "connected_app_search");
    if (!search) throw new Error("connected_app_search missing");

    const result = await search.execute(
      actionContext({
        provider: "x",
        query: "openpond",
        operation: "x.search.posts",
        capabilityIds: ["x.search.read"],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.contentText).toContain("Connected app operation x.search.posts was denied.");
    expect(result.contentText).toContain("Provider returned HTTP 402 Payment Required: credits depleted.");
    expect(result.contentText).not.toContain("conn_x");
  });

  test("infers connected app capabilities from provider operation ids", async () => {
    const executorRequests: unknown[] = [];
    const definitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [xConnectedAppContext()],
      executeConnectedAppTool: async (request) => {
        executorRequests.push(request);
        return {
          ok: true,
          output: `Completed ${request.operation}.`,
          data: { ref: request.args.ref ?? "x:post:2073551549494596079" },
        };
      },
    });
    const search = definitions.find((definition) => definition.name === "connected_app_search");
    const read = definitions.find((definition) => definition.name === "connected_app_read");
    if (!search || !read) throw new Error("connected app provider tools missing");

    const searchResult = await search.execute(
      actionContext({
        provider: "x",
        query: "conversation_id:2073551549494596079",
        operation: "x.search.posts",
      }),
    );
    const readResult = await read.execute(
      actionContext({
        provider: "x",
        ref: "https://x.com/thsottiaux/status/2073551549494596079",
        operation: "x.post.read",
      }),
    );

    expect(searchResult.ok).toBe(true);
    expect(readResult.ok).toBe(true);
    expect(executorRequests).toMatchObject([
      {
        provider: "x",
        operation: "search",
        capabilityIds: ["x.search.read"],
        args: {
          provider: "x",
          query: "conversation_id:2073551549494596079",
          operation: "x.search.posts",
        },
      },
      {
        provider: "x",
        operation: "read",
        capabilityIds: ["x.search.read"],
        args: {
          provider: "x",
          ref: "https://x.com/thsottiaux/status/2073551549494596079",
          operation: "x.post.read",
        },
      },
    ]);
  });

  test("gates connected app writes on explicit intent and write capabilities", async () => {
    const definitions = createConnectedAppProviderModelToolDefinitions({
      connectedApps: [googleConnectedAppContext()],
    });
    const write = definitions.find((definition) => definition.name === "connected_app_write");
    if (!write) throw new Error("connected_app_write missing");

    const missingIntent = await write.execute(
      actionContext({
        provider: "google",
        operation: "google.docs.update",
        input: { ref: "google:doc:1", patch: "Hello" },
      }),
    );
    const readCapability = await write.execute(
      actionContext({
        provider: "google",
        operation: "google.docs.update",
        input: { ref: "google:doc:1", patch: "Hello" },
        explicitUserIntent: "User asked to update google:doc:1.",
        capabilityIds: ["google.drive.file.read"],
      }),
    );
    const unknownOperation = await write.execute(
      actionContext({
        provider: "google",
        operation: "update_doc",
        input: { ref: "google:doc:1", patch: "Hello" },
        explicitUserIntent: "User asked to update google:doc:1.",
        capabilityIds: ["google.docs.write"],
      }),
    );
    const unavailable = await write.execute(
      actionContext({
        provider: "google",
        operation: "google.docs.update",
        input: { ref: "google:doc:1", patch: "Hello" },
        explicitUserIntent: "User asked to update google:doc:1.",
        capabilityIds: ["google.docs.write"],
      }),
    );

    expect(missingIntent.ok).toBe(false);
    expect(missingIntent.contentText).toContain("explicitUserIntent");
    expect(readCapability.ok).toBe(false);
    expect(readCapability.contentText).toContain("not authorized");
    expect(unknownOperation.ok).toBe(false);
    expect(unknownOperation.contentText).toContain("operation update_doc is not allowed");
    expect(unavailable.ok).toBe(false);
    expect(unavailable.contentText).toContain("No provider API call was made");
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

  test("fetches known web URLs and extracts readable text", async () => {
    const tool = createWebFetchModelToolDefinition({
      fetchImpl: async () => new Response(
        "<html><head><title>Example page</title><style>.hidden{}</style></head><body><h1>Hello &amp; welcome</h1><script>ignored()</script><p>Readable text.</p></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    });

    const result = await tool.execute(actionContext({ url: "https://example.com/docs#section", maxBytes: 1000 }));

    expect(result.ok).toBe(true);
    expect(result.name).toBe("web_fetch");
    expect(result.contentText).toContain("Example page");
    expect(result.contentText).toContain("Hello & welcome");
    expect(result.contentText).toContain("Readable text.");
    expect(result.contentText).not.toContain("ignored()");
    expect(result.contentText).not.toContain("#section");
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

function googleConnectedAppContext(overrides: Partial<ResolvedConnectedAppContext> = {}): ResolvedConnectedAppContext {
  return {
    provider: "google",
    label: "Google",
    appIds: ["google"],
    setupSurfaces: ["oauth_connector"],
    accountLabels: ["Docs User"],
    workspaceLabels: ["Drive"],
    capabilities: [
      { access: "read", id: "google.drive.file.read", label: "Read Drive files" },
      { access: "write", id: "google.docs.write", label: "Edit Docs" },
    ],
    toolNames: [],
    connectionIds: ["conn_google"],
    ...overrides,
  };
}

function mcpConnectedAppContext(): ResolvedConnectedAppContext {
  return {
    provider: "mcp",
    label: "OpenPond MCP",
    appIds: ["mcp"],
    setupSurfaces: ["mcp_endpoint"],
    accountLabels: [],
    workspaceLabels: [],
    capabilities: [
      { access: "tooling", id: "mcp.tool.discover", label: "Discover tools" },
    ],
    toolNames: [],
    connectionIds: [],
  };
}

function xConnectedAppContext(): ResolvedConnectedAppContext {
  return {
    provider: "x",
    label: "X",
    appIds: ["x"],
    setupSurfaces: ["oauth_connector"],
    accountLabels: ["0xglu"],
    workspaceLabels: [],
    capabilities: [
      { access: "read", id: "x.profile.read", label: "Read profile" },
      { access: "read", id: "x.search.read", label: "Search X" },
      { access: "read", id: "x.mentions.read", label: "Read mentions" },
      { access: "write", id: "x.post.write", label: "Post" },
    ],
    toolNames: [],
    connectionIds: ["conn_x"],
  };
}

function actionContext(args: Record<string, unknown>, sessionOverrides: Partial<Session> = {}) {
  return {
    session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1", ...sessionOverrides }),
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

function browserExecutor(input: {
  available: boolean;
  calls?: unknown[];
}): BrowserHarnessToolExecutor {
  const calls = input.calls ?? [];
  const result = (action: BrowserHarnessToolName, output: string, data: Record<string, unknown> = {}) => ({
    ok: true,
    action,
    output,
    data,
    metadata: {
      activeTabId: "tab_1",
      url: "https://example.com/app?token=secret",
      snapshotId: "snap_1",
      cursor: { x: 10, y: 20 },
    },
  });
  return {
    available: () => input.available,
    async open(request) {
      calls.push({ method: "open", url: request.url ?? null });
      return result("openpond_browser_open", "Opened browser.");
    },
    async snapshot(request) {
      calls.push({ method: "snapshot", maxTargets: request.maxTargets });
      return result("openpond_browser_snapshot", "Captured browser.", {
        snapshotId: "snap_1",
        targets: [],
      });
    },
    async moveCursor(request) {
      calls.push({ method: "moveCursor", target: request.target });
      return result("openpond_browser_move_cursor", "Moved cursor.");
    },
    async click(request) {
      calls.push({
        method: "click",
        target: request.target,
        button: request.button,
        clickCount: request.clickCount,
      });
      return result("openpond_browser_click", "Clicked browser.");
    },
    async typeText(request) {
      calls.push({
        method: "typeText",
        ...(request.target ? { target: request.target } : {}),
        textLength: request.text.length,
      });
      return result("openpond_browser_type", "Typed in browser.");
    },
    async pressKey(request) {
      calls.push({ method: "pressKey", key: request.key });
      return result("openpond_browser_key", "Pressed key.");
    },
    async scroll(request) {
      calls.push({
        method: "scroll",
        ...(request.target ? { target: request.target } : {}),
        deltaX: request.deltaX,
        deltaY: request.deltaY,
      });
      return result("openpond_browser_scroll", "Scrolled browser.");
    },
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
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
