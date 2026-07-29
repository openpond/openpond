import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import {
  createWorkOutputService,
  normalizeOutputCandidatePath,
} from "../apps/server/src/work/work-output-service";

describe("Work output service", () => {
  test("atomically saves a bounded sandbox output with stable provenance and revisions", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-output-")
    );
    const events: RuntimeEvent[] = [];
    const bytes = Buffer.from("# Finished report\n");
    const sandboxRequests: unknown[] = [];
    const service = createWorkOutputService({
      deviceId: "device_test",
      storeDir,
      runtimeEventsForSession: async () => events,
      sandboxRequest: async (request) => {
        sandboxRequests.push(request);
        return {
          file: {
            contentsBase64: bytes.toString("base64"),
            totalSizeBytes: bytes.byteLength,
            truncated: false,
          },
        };
      },
    });

    try {
      const first = await service.saveWorkOutput({
        session: workSession(),
        sourceTurnId: "turn_1",
        sandboxPath: "outputs/report.md",
      });
      events.push(runtimeEvent(first.outputRef));
      const second = await service.saveWorkOutput({
        session: workSession(),
        sourceTurnId: "turn_2",
        sandboxPath: "outputs/report.md",
      });
      events.push(runtimeEvent(second.outputRef));

      expect(first.outputRef).toMatchObject({
        kind: "file",
        title: "report.md",
        contentType: "text/markdown",
        sizeBytes: bytes.byteLength,
        sourceTaskId: "session_work",
        sourceTurnId: "turn_1",
        revision: 1,
        location: {
          kind: "local",
          deviceId: "device_test",
        },
      });
      expect(first.outputRef.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(second.outputRef.id).toBe(first.outputRef.id);
      expect(second.outputRef.revision).toBe(2);
      expect(await readFile(first.outputRef.location.path, "utf8")).toBe(
        bytes.toString("utf8")
      );
      expect(await readFile(second.outputRef.location.path, "utf8")).toBe(
        bytes.toString("utf8")
      );
      await expect(
        service.readWorkOutput({
          session: {
            ...workSession(),
            status: "idle",
            metadata: { workSandboxState: "stopped" },
          },
          outputId: first.outputRef.id,
          revision: first.outputRef.revision,
        })
      ).resolves.toMatchObject({
        outputRef: { id: first.outputRef.id, revision: 1 },
        contentsBase64: bytes.toString("base64"),
      });
      await expect(
        service.deleteWorkOutput({
          session: workSession(),
          outputId: second.outputRef.id,
          revision: second.outputRef.revision,
        })
      ).resolves.toMatchObject({ deleted: true });
      await expect(
        readFile(second.outputRef.location.path, "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(sandboxRequests).toEqual([
        expect.objectContaining({
          type: "download_file",
          sandboxId: "sandbox_work",
          payload: {
            path: "outputs/report.md",
            maxBytes: 10_000_000,
          },
        }),
        expect.anything(),
      ]);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("requires completed candidates under outputs and rejects truncated downloads", async () => {
    expect(() => normalizeOutputCandidatePath("../report.md")).toThrow(
      "/workspace/outputs"
    );
    expect(() => normalizeOutputCandidatePath("work/report.md")).toThrow(
      "/workspace/outputs"
    );

    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-output-")
    );
    try {
      const service = createWorkOutputService({
        deviceId: "device_test",
        storeDir,
        runtimeEventsForSession: async () => [],
        sandboxRequest: async () => ({
          file: {
            contentsBase64: Buffer.from("partial").toString("base64"),
            totalSizeBytes: 10_000_001,
            truncated: true,
          },
        }),
      });
      await expect(
        service.saveWorkOutput({
          session: workSession(),
          sourceTurnId: "turn_1",
          sandboxPath: "outputs/too-large.md",
        })
      ).rejects.toThrow("10,000,000 byte limit");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("rejects structurally invalid rich outputs and requires visual evidence", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-output-")
    );
    let bytes = Buffer.from("not a pdf");
    try {
      const service = createWorkOutputService({
        deviceId: "device_test",
        storeDir,
        runtimeEventsForSession: async () => [],
        sandboxRequest: async () => ({
          file: {
            contentsBase64: bytes.toString("base64"),
            totalSizeBytes: bytes.byteLength,
            truncated: false,
          },
        }),
      });
      await expect(
        service.saveWorkOutput({
          session: workSession(),
          sourceTurnId: "turn_pdf",
          sandboxPath: "outputs/report.pdf",
        })
      ).rejects.toThrow("failed structural validation");
      await expect(access(service.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });

      bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
      await expect(
        service.saveWorkOutput({
          session: workSession(),
          sourceTurnId: "turn_pdf",
          sandboxPath: "outputs/report.pdf",
        })
      ).rejects.toThrow("requires passed visual validation");
      await expect(access(service.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(
        service.saveWorkOutput({
          session: workSession(),
          sourceTurnId: "turn_pdf",
          sandboxPath: "outputs/report.pdf",
          validation: [
            {
              kind: "visual",
              status: "passed",
              label: "Rendered pages inspected",
            },
          ],
        })
      ).resolves.toMatchObject({
        outputRef: {
          contentType: "application/pdf",
          validation: [
            { kind: "structural", status: "passed" },
            { kind: "visual", status: "passed" },
          ],
        },
      });
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("rejects unadvertised completed output formats", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-output-")
    );
    try {
      const bytes = Buffer.from("temporary scratch data");
      const service = createWorkOutputService({
        deviceId: "device_test",
        storeDir,
        runtimeEventsForSession: async () => [],
        sandboxRequest: async () => ({
          file: {
            contentsBase64: bytes.toString("base64"),
            totalSizeBytes: bytes.byteLength,
            truncated: false,
          },
        }),
      });
      await expect(
        service.saveWorkOutput({
          session: workSession(),
          sourceTurnId: "turn_unknown",
          sandboxPath: "outputs/archive.bin",
        })
      ).rejects.toThrow("not an advertised Work output format");
      await expect(access(service.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

function runtimeEvent(outputRef: unknown): RuntimeEvent {
  return {
    id: "event_output_1",
    sessionId: "session_work",
    turnId: "turn_1",
    name: "workspace_action",
    timestamp: "2026-07-28T10:00:01.000Z",
    source: "chat_action",
    action: "sandbox_save_output",
    status: "completed",
    data: { outputRef },
  };
}

function workSession(): Session {
  return {
    id: "session_work",
    experience: "work",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "Work task",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "sandbox_work",
    workspaceName: "Work sandbox",
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    status: "active",
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
  };
}
