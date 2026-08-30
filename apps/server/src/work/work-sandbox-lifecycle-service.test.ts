import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { createWorkSandboxLifecycleService } from "./work-sandbox-lifecycle-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Work sandbox lifecycle service", () => {
  test("persists outputs before deleting and detaching compute", async () => {
    const storeDir = await temporaryStore();
    const order: string[] = [];
    const events: RuntimeEvent[] = [];
    const session = workSession();
    const service = createWorkSandboxLifecycleService({
      storeDir,
      saveAllWorkOutputs: async () => {
        order.push("persist");
        return [];
      },
      sandboxRequest: async ({ type }) => {
        order.push(type);
        return {};
      },
      updateSession: async (_sessionId, patch) => {
        order.push("detach");
        return { ...session, ...patch };
      },
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    const finalized = await service.finalizeTurn({
      session,
      turnId: "turn_1",
      outcome: "completed",
    });

    expect(order).toEqual(["persist", "delete", "detach"]);
    expect(finalized.workspaceId).toBeNull();
    expect(events.at(-1)).toMatchObject({
      action: "work_sandbox_cleanup",
      status: "completed",
      data: { sandboxId: "sandbox_1", outputCount: 0 },
    });
  });

  test("stops and retains compute when output persistence fails", async () => {
    const storeDir = await temporaryStore();
    const calls: string[] = [];
    const session = workSession();
    const persistenceError = new Error("disk full");
    const updateSession = vi.fn();
    const service = createWorkSandboxLifecycleService({
      storeDir,
      saveAllWorkOutputs: async () => {
        throw persistenceError;
      },
      sandboxRequest: async ({ type }) => {
        calls.push(type);
        return {};
      },
      updateSession,
      appendRuntimeEvent: async () => undefined,
    });

    await expect(
      service.finalizeTurn({
        session,
        turnId: "turn_1",
        outcome: "failed",
      })
    ).rejects.toBe(persistenceError);
    expect(calls).toEqual(["stop"]);
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("persists managed local Work outputs without detaching or deleting the workspace", async () => {
    const storeDir = await temporaryStore();
    const session: Session = {
      ...workSession(),
      id: "local_task_1",
      workspaceKind: undefined,
      workspaceId: null,
      workspaceName: null,
      cwd: path.join(storeDir, "work", "tasks", "local_task_1"),
      metadata: { workspaceTarget: "local" },
    };
    const events: RuntimeEvent[] = [];
    const sandboxRequest = vi.fn();
    const updateSession = vi.fn();
    const service = createWorkSandboxLifecycleService({
      storeDir,
      saveAllWorkOutputs: async () => [
        {
          outputRef: {
            kind: "file",
            id: "output_1",
            title: "report.csv",
            contentType: "text/csv",
            sizeBytes: 12,
            sha256: "a".repeat(64),
            sourceTaskId: session.id,
            sourceTurnId: "turn_1",
            revision: 1,
            createdAt: "2026-08-30T14:00:00.000Z",
            location: {
              kind: "local",
              path: path.join(storeDir, "work", "outputs", "report.csv"),
              deviceId: "device_1",
            },
            validation: [],
          },
          artifact: {
            artifactRef: path.join(storeDir, "work", "outputs", "report.csv"),
            path: path.join(storeDir, "work", "outputs", "report.csv"),
            title: "report.csv",
            contentType: "text/csv",
            sizeBytes: 12,
          },
        },
      ],
      sandboxRequest,
      updateSession,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    await expect(
      service.finalizeTurn({
        session,
        turnId: "turn_1",
        outcome: "completed",
      }),
    ).resolves.toBe(session);
    expect(sandboxRequest).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        action: "work_output_save",
        status: "completed",
        data: expect.objectContaining({
          outputRef: expect.objectContaining({ title: "report.csv" }),
        }),
      }),
    ]);
  });

  test("durably retries deletion without keeping the session attached", async () => {
    const storeDir = await temporaryStore();
    const session = workSession();
    let deleteAttempts = 0;
    let deletionAvailable = false;
    const service = createWorkSandboxLifecycleService({
      storeDir,
      saveAllWorkOutputs: async () => [],
      sandboxRequest: async ({ type }) => {
        if (type === "delete") {
          deleteAttempts += 1;
          if (!deletionAvailable) throw new Error("control plane unavailable");
        }
        return {};
      },
      updateSession: async (_sessionId, patch) => ({ ...session, ...patch }),
      appendRuntimeEvent: async () => undefined,
    });

    const finalized = await service.finalizeTurn({
      session,
      turnId: "turn_1",
      outcome: "completed",
    });
    expect(finalized.workspaceId).toBeNull();
    expect(deleteAttempts).toBe(1);
    const outboxPath = path.join(
      storeDir,
      "work",
      "sandbox-cleanup-outbox.json"
    );
    expect(JSON.parse(await readFile(outboxPath, "utf8"))).toHaveLength(1);

    deletionAvailable = true;
    await service.retryPending();
    expect(deleteAttempts).toBe(2);
    expect(JSON.parse(await readFile(outboxPath, "utf8"))).toEqual([]);
  });
});

async function temporaryStore(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-work-life-"));
  temporaryDirectories.push(directory);
  return directory;
}

function workSession(): Session {
  return {
    id: "work_task_1",
    experience: "work",
    provider: "openpond",
    modelRef: null,
    openPondCommandAccessMode: "disabled",
    title: "Work task",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "sandbox_1",
    workspaceName: "Work sandbox",
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    status: "active",
    pinned: false,
    archived: false,
    order: 0,
    metadata: {},
  };
}
