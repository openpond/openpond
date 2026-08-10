import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionSchema, type Session } from "@openpond/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { waitForWorkSandboxReady } from "../openpond/work-tool-registry.js";
import { createLocalTasksetWorkRuntime } from "./local-taskset-work-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe("local Taskset Work runtime", () => {
  test("satisfies Work readiness without provisioning hosted compute", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-local-work-"));
    temporaryRoots.push(root);
    let session: Session | null = null;
    const runtime = createLocalTasksetWorkRuntime({
      storeDir: root,
      deviceId: "test-device",
      createSession: async (payload) => {
        const input = payload as Record<string, unknown>;
        const now = new Date().toISOString();
        session = SessionSchema.parse({
          ...input,
          id: "local-attempt",
          provider: "openpond",
          title: input.title ?? "Local benchmark attempt",
          appId: null,
          appName: null,
          cwd: path.join(root, "work", "tasks", "local-attempt"),
          codexThreadId: null,
          createdAt: now,
          updatedAt: now,
          status: "idle",
          pinned: false,
          archived: false,
          order: 0,
        });
        return session;
      },
      getSession: async () => {
        if (!session) throw new Error("Session was not created.");
        return session;
      },
      runtimeEventsForSession: async () => [],
    });

    const created = await runtime.createSession({
      experience: "work",
      hiddenFromDefaultSidebar: true,
      metadata: { taskId: "frozen-clinic-relocation-brief" },
    });
    expect(created.hiddenFromDefaultSidebar).toBe(false);
    expect(created.title).toBe("Benchmark · Clinic relocation brief");
    expect(created.metadata).toMatchObject({
      workspaceTarget: "local",
      benchmarkRuntime: "desktop_local_work",
    });

    const status = await waitForWorkSandboxReady(() =>
      runtime.executeWorkspaceTool(created.id, {
        action: "sandbox_status",
        args: {},
      })
    );
    expect(status.data).toMatchObject({
      sandbox: { state: "running", provider: "desktop-local" },
      executionBacked: true,
    });

    const write = await runtime.executeWorkspaceTool(created.id, {
      action: "sandbox_write_file",
      args: { path: "/workspace/work/note.txt", content: "local" },
    });
    expect(write.ok).toBe(true);
    await expect(
      fs.readFile(path.join(created.cwd!, "work", "note.txt"), "utf8"),
    ).resolves.toBe("local");

    const execute = await runtime.executeWorkspaceTool(created.id, {
      action: "sandbox_exec",
      args: {
        command:
          "python3 -c \"from pathlib import Path; Path('/workspace/outputs/result.txt').write_text('mounted')\"",
      },
    });
    expect(execute, execute.output).toMatchObject({ ok: true });
    await expect(
      fs.readFile(path.join(created.cwd!, "outputs", "result.txt"), "utf8"),
    ).resolves.toBe("mounted");
  });
});
