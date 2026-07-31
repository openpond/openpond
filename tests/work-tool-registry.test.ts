import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Session,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { createWorkModelToolDefinitions } from "../apps/server/src/openpond/work-tool-registry";

describe("Work model tools", () => {
  test("lazily creates exactly one projectless sandbox and reuses it within the turn", async () => {
    const calls: WorkspaceToolRequest[] = [];
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        return {
          ok: true,
          action: request.action,
          output: "ok",
          data:
            request.action === "sandbox_status"
              ? { sandbox: { id: "sandbox_1", state: "running" } }
              : {},
        } satisfies WorkspaceToolResult;
      },
    });
    const environment = definitions.find(
      (definition) => definition.name === "work_environment"
    );
    const exec = definitions.find(
      (definition) => definition.name === "work_exec"
    );
    if (!environment || !exec) throw new Error("Work tools missing");
    const session = workSession();

    await Promise.all([
      environment.execute(toolContext(session, "call_environment", {})),
      exec.execute(
        toolContext(session, "call_exec", {
          command: "python -V",
          timeoutSeconds: 30,
        })
      ),
    ]);

    const creates = calls.filter((call) => call.action === "sandbox_create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      args: {
        attachToSession: true,
        command: "mkdir -p inputs work outputs",
        visibility: "private",
        reuseDefaultRuntime: false,
        markDefaultRuntime: false,
        runtime: {
          runtimeProfileId: "openpond-work-v1",
          workflowMode: "attempt",
          promotionPolicy: "none",
          metadata: {
            source: "openpond-work",
            experience: "work",
          },
        },
      },
    });
    expect(JSON.stringify(creates[0])).not.toMatch(
      /api[_-]?key|authorization|credential|oauth|token/i
    );
    expect(calls.filter((call) => call.action === "sandbox_exec")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.objectContaining({
            command: "cd /workspace/work && python -V",
            timeoutSeconds: 30,
          }),
        }),
        expect.objectContaining({
          args: expect.objectContaining({
            command: expect.stringContaining('printf "tools="'),
            timeoutSeconds: 30,
          }),
        }),
      ])
    );
  });

  test("rejects paths that escape their selected Work area", async () => {
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        return {
          ok: true,
          action: request.action,
          output: "ok",
        } satisfies WorkspaceToolResult;
      },
    });
    const write = definitions.find(
      (definition) => definition.name === "work_write_file"
    );
    if (!write) throw new Error("work_write_file missing");

    await expect(
      write.execute(
        toolContext(
          workSession({
            workspaceKind: "sandbox",
            workspaceId: "sandbox_1",
          }),
          "call_write",
          {
            area: "outputs",
            path: "../outside.md",
            content: "no",
          }
        )
      )
    ).rejects.toThrow("escaped");
  });

  test("does not report simulated command acknowledgements as executed work", async () => {
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        if (request.action === "sandbox_status") {
          return {
            ok: true,
            action: request.action,
            output: "running",
            data: { sandbox: { id: "sandbox_1", state: "running" } },
          } satisfies WorkspaceToolResult;
        }
        if (request.action === "sandbox_exec") {
          return {
            ok: true,
            action: request.action,
            output:
              "Command succeeded\n[poc-runner] command accepted by simulated-firecracker driver\n[poc-runner] no host command was executed",
            data: { command: { status: "succeeded", exitCode: 0 } },
          } satisfies WorkspaceToolResult;
        }
        return {
          ok: true,
          action: request.action,
          output: "ok",
        } satisfies WorkspaceToolResult;
      },
    });
    const session = workSession({
      workspaceKind: "sandbox",
      workspaceId: "sandbox_1",
    });
    const environment = definitions.find(
      (definition) => definition.name === "work_environment"
    );
    const exec = definitions.find(
      (definition) => definition.name === "work_exec"
    );
    if (!environment || !exec) throw new Error("Work tools missing");

    const environmentResult = await environment.execute(
      toolContext(session, "call_environment", {})
    );
    const execResult = await exec.execute(
      toolContext(session, "call_exec", {
        command: "node -v",
        timeoutSeconds: 30,
      })
    );

    expect(environmentResult).toMatchObject({
      ok: false,
      data: { executionBacked: false },
    });
    expect(environmentResult.contentText).toContain(
      "does not currently execute commands"
    );
    expect(execResult).toMatchObject({
      ok: false,
      data: {
        code: "sandbox_execution_unavailable",
        executionBacked: false,
      },
    });
  });

  test("materializes bounded file and folder inputs exactly once before Work commands", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-inputs-")
    );
    const firstPath = path.join(tempDir, "brief.md");
    const secondPath = path.join(tempDir, "data.csv");
    await writeFile(firstPath, "# Brief\n", "utf8");
    await writeFile(secondPath, "name,value\nA,1\n", "utf8");
    const calls: WorkspaceToolRequest[] = [];
    try {
      const definitions = createWorkModelToolDefinitions({
        inputs: [
          { localPath: firstPath, storageName: "brief.md" },
          { localPath: secondPath, storageName: "research/data.csv" },
        ],
        executeWorkspaceTool: async (_sessionId, payload) => {
          const request = payload as WorkspaceToolRequest;
          calls.push(request);
          return {
            ok: true,
            action: request.action,
            output: "ok",
            data:
              request.action === "sandbox_status"
                ? { sandbox: { id: "sandbox_1", state: "running" } }
                : {},
          } satisfies WorkspaceToolResult;
        },
      });
      const environment = definitions.find(
        (definition) => definition.name === "work_environment"
      );
      const list = definitions.find(
        (definition) => definition.name === "work_list_files"
      );
      if (!environment || !list) throw new Error("Work tools missing");
      const session = workSession();

      await environment.execute(toolContext(session, "call_environment", {}));
      await list.execute(
        toolContext(session, "call_list", { area: "inputs", recursive: true })
      );

      expect(
        calls.filter((call) => call.action === "sandbox_create")
      ).toHaveLength(1);
      expect(
        calls
          .filter((call) => call.action === "sandbox_upload_file")
          .map((call) => ({
            path: call.args.path,
            contents: Buffer.from(
              String(call.args.contentsBase64),
              "base64"
            ).toString("utf8"),
          }))
      ).toEqual([
        { path: "inputs/brief.md", contents: "# Brief\n" },
        {
          path: "inputs/research/data.csv",
          contents: "name,value\nA,1\n",
        },
      ]);
      expect(
        calls.filter((call) => call.action === "sandbox_upload_file")
      ).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("resumes a stopped attached Work sandbox before revising it", async () => {
    const calls: WorkspaceToolRequest[] = [];
    let statusCallCount = 0;
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        if (request.action === "sandbox_status") statusCallCount += 1;
        return {
          ok: true,
          action: request.action,
          output: "ok",
          data:
            request.action === "sandbox_status"
              ? {
                  sandbox: {
                    id: "sandbox_1",
                    state: statusCallCount === 1 ? "stopped" : "running",
                  },
                }
              : {},
        } satisfies WorkspaceToolResult;
      },
    });
    const read = definitions.find(
      (definition) => definition.name === "work_read_file"
    );
    if (!read) throw new Error("work_read_file missing");

    await read.execute(
      toolContext(
        workSession({
          workspaceKind: "sandbox",
          workspaceId: "sandbox_1",
        }),
        "call_read",
        { area: "work", path: "draft.md" }
      )
    );

    expect(calls.map((call) => call.action)).toEqual([
      "sandbox_status",
      "sandbox_start",
      "sandbox_status",
      "sandbox_read_file",
    ]);
  });

  test("does not provision compute just to stop an unattached Work task", async () => {
    const calls: WorkspaceToolRequest[] = [];
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        return {
          ok: true,
          action: request.action,
          output: "ok",
        } satisfies WorkspaceToolResult;
      },
    });
    const stop = definitions.find(
      (definition) => definition.name === "work_stop"
    );
    if (!stop) throw new Error("work_stop missing");

    const result = await stop.execute(
      toolContext(workSession(), "call_stop", {})
    );

    expect(result.ok).toBe(true);
    expect(result.contentText).toContain("not_attached");
    expect(calls).toEqual([]);
  });

  test("reports supported formats and destinations without provisioning compute", async () => {
    const calls: WorkspaceToolRequest[] = [];
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        return {
          ok: true,
          action: request.action,
          output: "ok",
        } satisfies WorkspaceToolResult;
      },
    });
    const capabilities = definitions.find(
      (definition) => definition.name === "work_capabilities"
    );
    if (!capabilities) throw new Error("work_capabilities missing");

    const result = await capabilities.execute(
      toolContext(workSession(), "call_capabilities", {})
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      compute: "lazy",
      destinations: [
        "managed_local_file",
        "approved_connected_resource",
        "deployment_url",
      ],
    });
    expect(result.contentText).toContain('"requiresTurnPermission": true');
    expect(result.contentText).toContain('"guestCredentials": false');
    expect(calls).toEqual([]);
  });

  test("registers a connected result without provisioning sandbox compute", async () => {
    const calls: WorkspaceToolRequest[] = [];
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        return {
          ok: true,
          action: request.action,
          output: "ok",
        } satisfies WorkspaceToolResult;
      },
    });
    const register = definitions.find(
      (definition) => definition.name === "work_register_external_output"
    );
    if (!register) throw new Error("external output tool missing");

    const result = await register.execute(
      toolContext(workSession(), "call_external", {
        kind: "external_file",
        title: "Survey results",
        provider: "google",
        resourceId: "sheet_123",
        url: "https://docs.google.com/spreadsheets/d/sheet_123",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      outputRef: {
        kind: "external_resource",
        title: "Survey results",
        provider: "google",
        resourceId: "sheet_123",
      },
    });
    expect(calls).toEqual([]);
  });
});

function toolContext(
  session: Session,
  callId: string,
  args: Record<string, unknown>
) {
  return {
    session,
    turnId: "turn_1",
    callId,
    args,
    provider: "openrouter" as const,
    model: "test/model",
    mentionedApps: [],
    userPrompt: "Complete the work.",
    turnMetadata: {},
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
  };
}

function workSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_work",
    experience: "work",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "Work task",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    status: "idle",
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
