import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Approval, RuntimeEvent, Session } from "@openpond/contracts";
import {
  classifyCommandFamily,
  createOpenPondCommandAccessService,
  SELECT_PROJECT_MESSAGE,
} from "../apps/server/src/openpond/command-access";

describe("OpenPond command access service", () => {
  test("classifies broad command families conservatively", () => {
    expect(classifyCommandFamily("docker system df")).toMatchObject({
      key: "docker system",
      broad: true,
    });
    expect(classifyCommandFamily("FOO=bar bun run test")).toMatchObject({
      key: "bun run",
      broad: true,
    });
    expect(classifyCommandFamily("echo hi | cat")).toMatchObject({
      key: "exact:echo hi | cat",
      broad: false,
    });
    expect(classifyCommandFamily("git push")).toMatchObject({
      key: "exact:git push",
      broad: false,
    });
  });

  test("blocks command execution without a selected local project", async () => {
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (_approval) => undefined,
      appendRuntimeEvent: async (_event) => undefined,
    });

    const result = await service.executeCommand({
      session: session({ workspaceKind: undefined, cwd: null }),
      command: "pwd",
      source: "model_tool",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe(SELECT_PROJECT_MESSAGE);
  });

  test("runs full-access commands in the selected project cwd", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openpond-command-access-"));
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (_approval) => undefined,
      appendRuntimeEvent: async (_event) => undefined,
    });

    try {
      const expectedCwd = await realpath(cwd);
      const result = await service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "full-access" }),
        command: `${JSON.stringify(process.execPath)} -e "console.log(process.cwd())"`,
        source: "model_tool",
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expectedCwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("runs full-access commands in a cwd-only local session", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openpond-command-access-cwd-"));
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (_approval) => undefined,
      appendRuntimeEvent: async (_event) => undefined,
    });

    try {
      const expectedCwd = await realpath(cwd);
      const result = await service.executeCommand({
        session: session({
          workspaceKind: undefined,
          workspaceId: null,
          localProjectId: null,
          cwd,
          openPondCommandAccessMode: "full-access",
        }),
        command: `${JSON.stringify(process.execPath)} -e "console.log(process.cwd())"`,
        source: "model_tool",
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expectedCwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("terminates descendant processes when a command times out", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openpond-command-timeout-"));
    const pidPath = path.join(cwd, "descendant.pid");
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (_approval) => undefined,
      appendRuntimeEvent: async (_event) => undefined,
    });

    try {
      const childProgram = [
        "const fs=require('node:fs')",
        `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid))`,
        "setInterval(()=>{},1000)",
      ].join(";");
      const result = await service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "full-access" }),
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childProgram)} & wait`,
        timeoutSeconds: 1,
        source: "model_tool",
      });

      expect(result.timedOut).toBe(true);
      const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
      expect(Number.isInteger(descendantPid)).toBe(true);
      await expectProcessToExit(descendantPid);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves failing pipeline status for validation commands", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openpond-command-access-pipefail-"));
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (_approval) => undefined,
      appendRuntimeEvent: async (_event) => undefined,
    });

    try {
      const command = `${JSON.stringify(process.execPath)} -e "console.log('failing validation'); process.exit(7)" | tail -40`;
      const result = await service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "full-access" }),
        command,
        source: "model_tool",
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.stdout.trim()).toBe("failing validation");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("disabled mode blocks commands without asking for approval", async () => {
    const approvals: Approval[] = [];
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (approval) => {
        approvals.push(approval);
      },
      appendRuntimeEvent: async (_event) => undefined,
    });

    const result = await service.executeCommand({
      session: session({ openPondCommandAccessMode: "disabled" }),
      command: "pwd",
      source: "direct_command",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("Command access is disabled for this chat.");
    expect(approvals).toHaveLength(0);
  });

  test("ask mode waits for approval before running", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openpond-command-access-"));
    const approvals: Approval[] = [];
    const events: RuntimeEvent[] = [];
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (approval) => {
        approvals.push(approval);
      },
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    try {
      const pending = service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "ask" }),
        turnId: "turn_1",
        command: `${JSON.stringify(process.execPath)} -e "console.log('approved')"`,
        source: "model_tool",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(approvals).toHaveLength(1);
      expect(events.some((event) => event.name === "approval.requested")).toBe(true);

      const approval = approvals[0]!;
      await service.resolveApproval(approval.id, { decision: "accept" });
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(result.stdout.trim()).toBe("approved");
      expect(approvals.at(-1)?.status).toBe("accepted");
      expect(events.some((event) => event.name === "approval.resolved")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("accept for session applies only to the visible command family", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openpond-command-access-"));
    const approvals: Approval[] = [];
    const service = createOpenPondCommandAccessService({
      upsertApproval: async (approval) => {
        approvals.push(approval);
      },
      appendRuntimeEvent: async (_event) => undefined,
    });

    try {
      const first = service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "ask" }),
        turnId: "turn_1",
        command: "pwd",
        source: "model_tool",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(approvals).toHaveLength(1);
      expect(JSON.parse(approvals[0]!.detail).sessionApprovalFamily).toMatchObject({
        label: "pwd",
        broad: true,
      });

      await service.resolveApproval(approvals[0]!.id, { decision: "acceptForSession" });
      await expect(first).resolves.toMatchObject({ ok: true });

      const approvalsAfterSessionGrant = approvals.length;
      const sameFamily = await service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "ask" }),
        turnId: "turn_2",
        command: "pwd -P",
        source: "model_tool",
      });
      expect(sameFamily.ok).toBe(true);
      expect(approvals).toHaveLength(approvalsAfterSessionGrant);

      const exactCommand = service.executeCommand({
        session: session({ cwd, openPondCommandAccessMode: "ask" }),
        turnId: "turn_3",
        command: "echo hi",
        source: "model_tool",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(approvals).toHaveLength(approvalsAfterSessionGrant + 1);
      await service.resolveApproval(approvals.at(-1)!.id, { decision: "decline" });
      await expect(exactCommand).resolves.toMatchObject({
        ok: false,
        blockedReason: "Command was not approved.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Descendant process ${pid} was still alive after command timeout.`);
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "Local chat",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: "project_1",
    workspaceName: "Project",
    localProjectId: "project_1",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/project",
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
