import { describe, expect, test } from "bun:test";
import type {
  RuntimeEvent,
  Session,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { runOpenPondDirectCommand } from "../apps/server/src/openpond/direct-command";
import type {
  OpenPondCommandExecutionInput,
  OpenPondCommandRunResult,
} from "../apps/server/src/openpond/command-access";

describe("OpenPond direct command routing", () => {
  test("routes local project direct commands through command access", async () => {
    const events: RuntimeEvent[] = [];
    const calls: OpenPondCommandExecutionInput[] = [];
    const currentSession = session({
      workspaceKind: "local_project",
      workspaceId: "local_project_1",
      localProjectId: "local_project_1",
      cwd: "/repo/site",
      openPondCommandAccessMode: "full-access",
    });

    const response = await runOpenPondDirectCommand(
      {
        appendRuntimeEvent: async (runtimeEvent) => {
          events.push(runtimeEvent);
        },
        createCommandRunId: () => "direct_command_1",
        executeLocalCommand: async (input) => {
          calls.push(input);
          return localCommandResult({
            command: input.command,
            cwd: input.cwd ?? null,
            stdout: "/repo/site\n",
            timeoutSeconds: input.timeoutSeconds ?? 120,
          });
        },
        executeWorkspaceTool: async () => {
          throw new Error("sandbox tool should not run for local direct commands");
        },
        getSession: async () => currentSession,
      },
      {
        session: currentSession,
        command: "pwd",
        cwd: "/repo/site",
        timeoutSeconds: 10,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      session: currentSession,
      turnId: "direct_command_1",
      providerRequestId: "direct_command_1",
      command: "pwd",
      cwd: "/repo/site",
      timeoutSeconds: 10,
      source: "direct_command",
    });
    expect(events).toHaveLength(2);
    expect(response.events).toEqual(events);
    expect(response.session).toBe(currentSession);
    expect(response.result).toMatchObject({
      ok: true,
      command: "pwd",
      cwd: "/repo/site",
      stdout: "/repo/site\n",
    });
    expect(response.events.map((event) => event.name)).toEqual(["tool.started", "tool.completed"]);
    expect(response.events.map((event) => event.action)).toEqual(["exec_command", "exec_command"]);
    expect(response.events.map((event) => event.turnId)).toEqual(["direct_command_1", "direct_command_1"]);
  });

  test("routes sandbox direct commands through sandbox_exec workspace tooling", async () => {
    const events: RuntimeEvent[] = [
      runtimeEvent({
        id: "old_event",
        sessionId: "session_sandbox",
        turnId: "direct_command_2",
        name: "workspace_action",
      }),
    ];
    const workspaceCalls: Array<{
      sessionId: string;
      payload: unknown;
      options?: { turnId?: string };
    }> = [];
    const currentSession = session({
      id: "session_sandbox",
      workspaceKind: "sandbox",
      workspaceId: "sandbox_1",
      workspaceName: "Cloud Project",
      localProjectId: null,
      cloudProjectId: "sandbox_1",
      cloudTeamId: "team_1",
      cwd: null,
    });

    const response = await runOpenPondDirectCommand(
      {
        appendRuntimeEvent: async () => {
          throw new Error("direct sandbox commands should let workspace tooling emit events");
        },
        createCommandRunId: () => "direct_command_2",
        executeLocalCommand: async () => {
          throw new Error("local command access should not run for sandbox direct commands");
        },
        executeWorkspaceTool: async (sessionId, payload, options) => {
          workspaceCalls.push({ sessionId, payload, options });
          events.push(
            runtimeEvent({
              id: "sandbox_started",
              sessionId,
              turnId: options?.turnId,
              name: "workspace_action",
              source: "chat_action",
              action: "sandbox_exec",
              status: "started",
            }),
            runtimeEvent({
              id: "sandbox_completed",
              sessionId,
              turnId: options?.turnId,
              name: "workspace_action_result",
              source: "chat_action",
              action: "sandbox_exec",
              status: "completed",
              output: "Command succeeded\n\nok",
            }),
          );
          return workspaceResult({ output: "Command succeeded\n\nok" });
        },
        getSession: async () => currentSession,
        runtimeEventsForSession: async (sessionId) =>
          events.filter((event) => event.sessionId === sessionId),
      },
      {
        session: currentSession,
        command: "bun run typecheck",
        timeoutSeconds: 30,
      },
    );

    expect(workspaceCalls).toEqual([
      {
        sessionId: "session_sandbox",
        payload: {
          action: "sandbox_exec",
          args: {
            command: "bun run typecheck",
            timeoutSeconds: 30,
          },
          source: "chat_action",
        },
        options: { turnId: "direct_command_2" },
      },
    ]);
    expect(response.session).toBe(currentSession);
    expect(response.result).toEqual(workspaceResult({ output: "Command succeeded\n\nok" }));
    expect(response.events.map((event) => event.id)).toEqual(["sandbox_started", "sandbox_completed"]);
    expect(response.events.map((event) => event.name)).toEqual(["workspace_action", "workspace_action_result"]);
    expect(response.events.map((event) => event.action)).toEqual(["sandbox_exec", "sandbox_exec"]);
  });

  test("blocks sandbox direct commands before workspace tooling when no workspace id is selected", async () => {
    const events: RuntimeEvent[] = [];
    const currentSession = session({
      id: "session_sandbox_pending",
      workspaceKind: "sandbox",
      workspaceId: null,
      workspaceName: "Pending Sandbox",
      localProjectId: null,
      cloudProjectId: null,
      cloudTeamId: "team_1",
      cwd: null,
    });

    const response = await runOpenPondDirectCommand(
      {
        appendRuntimeEvent: async (runtimeEvent) => {
          events.push(runtimeEvent);
        },
        createCommandRunId: () => "direct_command_3",
        executeLocalCommand: async () => {
          throw new Error("local command access should not run for unready sandbox direct commands");
        },
        executeWorkspaceTool: async () => {
          throw new Error("sandbox tool should not run without a workspace id");
        },
        getSession: async () => currentSession,
      },
      {
        session: currentSession,
        command: "pwd",
      },
    );

    expect(response.result).toMatchObject({
      ok: false,
      command: "pwd",
      cwd: null,
      blockedReason: "Select a project to use this.",
    });
    expect(response.events).toEqual(events);
    expect(response.events.map((event) => event.name)).toEqual(["tool.started", "tool.completed"]);
    expect(response.events.map((event) => event.action)).toEqual(["exec_command", "exec_command"]);
    expect(response.events.map((event) => event.turnId)).toEqual(["direct_command_3", "direct_command_3"]);
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond/gpt-5" },
    openPondCommandAccessMode: "ask",
    title: "Direct command",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: "local_project_1",
    workspaceName: "Local Project",
    localProjectId: "local_project_1",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/repo/site",
    codexThreadId: null,
    createdAt: "2026-07-06T10:00:00.000Z",
    updatedAt: "2026-07-06T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-07-06T10:00:00.000Z",
    ...input,
  };
}

function localCommandResult(overrides: Partial<OpenPondCommandRunResult> = {}): OpenPondCommandRunResult {
  return {
    ok: true,
    command: "pwd",
    cwd: "/repo/site",
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    timeoutSeconds: 120,
    truncated: false,
    blockedReason: null,
    ...overrides,
  };
}

function workspaceResult(overrides: Partial<WorkspaceToolResult> = {}): WorkspaceToolResult {
  return {
    ok: true,
    action: "sandbox_exec",
    appId: null,
    output: "Command succeeded",
    data: {
      command: {
        status: "succeeded",
        output: "ok",
      },
    },
    ...overrides,
  };
}
