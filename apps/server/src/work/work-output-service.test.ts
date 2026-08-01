import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { createWorkOutputService } from "./work-output-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Work output service automatic preservation", () => {
  test("discovers outputs, preserves bytes, and exposes the latest revision as an input", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-output-")
    );
    temporaryDirectories.push(storeDir);
    const bytes = Buffer.from("%PDF-1.4\nbody\n%%EOF\n", "utf8");
    const events: RuntimeEvent[] = [];
    const service = createWorkOutputService({
      deviceId: "device_1",
      storeDir,
      runtimeEventsForSession: async () => events,
      sandboxRequest: async (request) => {
        if (request.type === "list_files") {
          return {
            files: [
              {
                path: "/workspace/outputs/report.pdf",
                type: "file",
                sizeBytes: bytes.byteLength,
                updatedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (request.type === "download_file") {
          return {
            file: {
              contentsBase64: bytes.toString("base64"),
              totalSizeBytes: bytes.byteLength,
              truncated: false,
            },
          };
        }
        throw new Error(`Unexpected sandbox request ${request.type}`);
      },
    });
    const session = workSession();

    const saved = await service.saveAllWorkOutputs({
      session,
      sourceTurnId: "turn_1",
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.outputRef).toMatchObject({
      title: "report.pdf",
      sourceTurnId: "turn_1",
      revision: 1,
      validation: expect.arrayContaining([
        expect.objectContaining({ kind: "structural", status: "passed" }),
        expect.objectContaining({ kind: "visual", status: "not_run" }),
      ]),
    });
    events.push({
      id: "event_1",
      timestamp: "2026-08-01T00:00:01.000Z",
      name: "workspace_action_result",
      data: saved[0],
    });

    const inputs = await service.workInputsForSession(session);
    expect(inputs).toEqual([
      expect.objectContaining({
        storageName: expect.stringContaining("report.pdf"),
        sha256: saved[0]?.outputRef.sha256,
        sizeBytes: bytes.byteLength,
      }),
    ]);
  });
});

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
