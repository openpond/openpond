import { describe, expect, test, vi } from "vitest";

import { OpenPondApiError } from "@openpond/cloud/api/core";
import type { OpenPondSandboxClient } from "@openpond/cloud/sandbox/client";
import type { SandboxRecord } from "@openpond/cloud/sandbox/types";
import { OpenPondWorkClient, type OpenPondWorkEvent } from "../src/work.js";

function sandbox(state: SandboxRecord["state"] = "running"): SandboxRecord {
  return {
    id: "sb_test",
    state,
    repo: null,
    teamId: "team_test",
    projectId: null,
    agentId: null,
    visibility: "private",
    ownerUserId: "user_test",
    billingAccountId: "billing_test",
    resources: { cpu: 2, memoryGb: 4, diskGb: 16 },
    budget: { maxUsd: "1.00" },
    reservation: {
      id: "reservation_test",
      status: "reserved",
      reservedUsd: "1.00",
      capturedUsd: "0.00",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    commands: [],
    previewPorts: [],
    receipts: [],
    logs: [],
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    stoppedAt: null,
    deletedAt: null,
  };
}

describe("OpenPondWorkClient", () => {
  test("creates a sandbox, executes model tool calls, and returns the final text", async () => {
    const record = sandbox();
    const fakeSandboxes = {
      create: vi.fn().mockResolvedValue(record),
      get: vi.fn().mockResolvedValue(record),
      mkdir: vi.fn().mockResolvedValue({ sandbox: record }),
      listFiles: vi
        .fn()
        .mockResolvedValueOnce({
          sandbox: record,
          files: [
            {
              path: "/workspace/outputs/previous.txt",
              type: "file",
              sizeBytes: 8,
              updatedAt: new Date(0).toISOString(),
              isBinary: false,
              previewable: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          sandbox: record,
          files: [
            {
              path: "/workspace/outputs/previous.txt",
              type: "file",
              sizeBytes: 8,
              updatedAt: new Date(0).toISOString(),
              isBinary: false,
              previewable: true,
            },
            {
              path: "/workspace/outputs/report.docx",
              type: "file",
              sizeBytes: 4812,
              updatedAt: new Date(1).toISOString(),
              isBinary: true,
              previewable: false,
            },
          ],
        }),
      downloadFileResponse: vi.fn().mockResolvedValue({
        sandbox: record,
        file: {
          path: "/workspace/outputs/report.docx",
          sizeBytes: 4812,
          updatedAt: new Date(1).toISOString(),
          isBinary: true,
          previewable: false,
          contentsBase64: "UEs=",
          offsetBytes: 0,
          returnedBytes: 2,
          totalSizeBytes: 2,
          truncated: false,
        },
      }),
      exec: vi.fn().mockResolvedValue({
        sandbox: record,
        command: {
          id: "cmd_test",
          command: "pwd",
          status: "succeeded",
          output: "/workspace\n",
          exitCode: 0,
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(0).toISOString(),
        },
      }),
      delete: vi.fn().mockResolvedValue(sandbox("deleted")),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_test",
                    type: "function",
                    function: { name: "run_command", arguments: '{"command":"pwd"}' },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: "Workspace is ready." } }] }),
      );
    const events: OpenPondWorkEvent[] = [];
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    const result = await work.run({
      prompt: "Inspect the workspace",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toEqual({
      sandboxId: "sb_test",
      text: "Workspace is ready.",
      steps: 2,
      lifecycle: {
        cleanupPolicy: "keep",
        persistence: {
          status: "not_requested",
          outputCount: 1,
          persistedCount: 0,
        },
        cleanup: { status: "not_requested" },
      },
      outputs: [
        {
          path: "/workspace/outputs/report.docx",
          name: "report.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 4812,
          updatedAt: new Date(1).toISOString(),
          isBinary: true,
          previewable: false,
        },
      ],
    });
    expect(fakeSandboxes.create).toHaveBeenCalledOnce();
    expect(fakeSandboxes.exec).toHaveBeenCalledWith("sb_test", {
      command: "pwd",
      timeoutSeconds: 180,
    });
    expect(events).toContainEqual({
      type: "tool",
      toolCallId: "call_test",
      command: "pwd",
      status: "succeeded",
      output: "/workspace\n",
      exitCode: 0,
    });
    await expect(work.downloadOutput(result.sandboxId, result.outputs[0]!)).resolves.toMatchObject({
      file: { path: "/workspace/outputs/report.docx", contentsBase64: "UEs=" },
    });
    expect(fakeSandboxes.downloadFileResponse).toHaveBeenCalledWith(
      "sb_test",
      "/workspace/outputs/report.docx",
    );
    expect(events).toContainEqual({
      type: "sandbox",
      sandboxId: "sb_test",
      state: "running",
    });
    expect(events).toContainEqual({
      type: "output",
      output: expect.objectContaining({
        path: "/workspace/outputs/report.docx",
        name: "report.docx",
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  test("resumes an existing stopped sandbox", async () => {
    const stopped = sandbox("stopped");
    const running = sandbox("running");
    const fakeSandboxes = {
      get: vi.fn().mockResolvedValueOnce(stopped).mockResolvedValue(running),
      start: vi.fn().mockResolvedValue({ sandbox: stopped }),
      mkdir: vi.fn().mockResolvedValue({ sandbox: running }),
      listFiles: vi.fn().mockResolvedValue({ sandbox: running, files: [] }),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "Continued." } }] }),
    );
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    await expect(work.run({ prompt: "Continue", sandboxId: "sb_test" })).resolves.toMatchObject({
      sandboxId: "sb_test",
      text: "Continued.",
    });
    expect(fakeSandboxes.start).toHaveBeenCalledWith("sb_test", { async: true });
    fetchMock.mockRestore();
  });

  test("propagates stable sandbox API failures", async () => {
    const record = sandbox();
    const unavailable = new OpenPondApiError(
      503,
      "sandbox_runner_unavailable",
      "Sandbox request",
    );
    const fakeSandboxes = {
      create: vi.fn().mockResolvedValue(record),
      get: vi.fn().mockResolvedValue(record),
      mkdir: vi.fn().mockResolvedValue({ sandbox: record }),
      listFiles: vi.fn().mockResolvedValue({ sandbox: record, files: [] }),
      exec: vi.fn().mockRejectedValue(unavailable),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_unavailable",
              type: "function",
              function: { name: "run_command", arguments: '{"command":"pwd"}' },
            }],
          },
        }],
      }),
    );
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    await expect(work.run({ prompt: "Run pwd" })).rejects.toBe(unavailable);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });

  test("persists every output before deleting the sandbox", async () => {
    const record = sandbox();
    const deleted = sandbox("deleted");
    const order: string[] = [];
    const outputFile = {
      path: "/workspace/outputs/report.pdf",
      type: "file" as const,
      sizeBytes: 3,
      updatedAt: new Date(1).toISOString(),
      isBinary: true,
      previewable: true,
    };
    const fakeSandboxes = {
      create: vi.fn().mockResolvedValue(record),
      get: vi.fn().mockResolvedValue(record),
      mkdir: vi.fn().mockResolvedValue({ sandbox: record }),
      listFiles: vi
        .fn()
        .mockResolvedValueOnce({ sandbox: record, files: [] })
        .mockResolvedValueOnce({ sandbox: record, files: [outputFile] }),
      downloadFileResponse: vi.fn().mockImplementation(async () => {
        order.push("download");
        return {
          sandbox: record,
          file: {
            ...outputFile,
            contentsBase64: "UEsD",
            offsetBytes: 0,
            returnedBytes: 3,
            totalSizeBytes: 3,
            truncated: false,
          },
        };
      }),
      delete: vi.fn().mockImplementation(async () => {
        order.push("delete");
        return deleted;
      }),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "Done." } }] }),
    );
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    const result = await work.run({
      prompt: "Create a PDF",
      cleanup: "delete",
      persistOutput: async ({ download }) => {
        order.push("persist-start");
        await Promise.all([download(), download()]);
        order.push("persist-complete");
      },
    });

    expect(order).toEqual([
      "persist-start",
      "download",
      "persist-complete",
      "delete",
    ]);
    expect(fakeSandboxes.downloadFileResponse).toHaveBeenCalledOnce();
    expect(fakeSandboxes.downloadFileResponse).toHaveBeenCalledWith("sb_test", {
      path: "/workspace/outputs/report.pdf",
      maxBytes: 3,
    });
    expect(result.lifecycle).toEqual({
      cleanupPolicy: "delete",
      persistence: {
        status: "complete",
        outputCount: 1,
        persistedCount: 1,
      },
      cleanup: { status: "complete", finalSandboxState: "deleted" },
    });
    fetchMock.mockRestore();
  });

  test("stops instead of deleting when output persistence fails", async () => {
    const record = sandbox();
    const stopped = sandbox("stopped");
    const persistenceFailure = new Error("object store unavailable");
    const fakeSandboxes = {
      create: vi.fn().mockResolvedValue(record),
      get: vi.fn().mockResolvedValue(record),
      mkdir: vi.fn().mockResolvedValue({ sandbox: record }),
      listFiles: vi
        .fn()
        .mockResolvedValueOnce({ sandbox: record, files: [] })
        .mockResolvedValueOnce({
          sandbox: record,
          files: [
            {
              path: "/workspace/outputs/result.txt",
              type: "file",
              sizeBytes: 6,
              updatedAt: new Date(1).toISOString(),
            },
          ],
        }),
      stop: vi.fn().mockResolvedValue({ sandbox: stopped }),
      delete: vi.fn(),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "Done." } }] }),
    );
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    await expect(
      work.run({
        prompt: "Create output",
        cleanup: "delete",
        persistOutput: async () => {
          throw persistenceFailure;
        },
      }),
    ).rejects.toBe(persistenceFailure);
    expect(fakeSandboxes.stop).toHaveBeenCalledWith("sb_test");
    expect(fakeSandboxes.delete).not.toHaveBeenCalled();
    expect(
      (persistenceFailure as Error & { workLifecycle?: unknown }).workLifecycle,
    ).toMatchObject({
      persistence: { status: "failed", persistedCount: 0 },
      cleanup: { status: "complete", finalSandboxState: "stopped" },
    });
    fetchMock.mockRestore();
  });

  test("requires explicit custody or discard before deleting outputs", async () => {
    const record = sandbox();
    const stopped = sandbox("stopped");
    const fakeSandboxes = {
      create: vi.fn().mockResolvedValue(record),
      get: vi.fn().mockResolvedValue(record),
      mkdir: vi.fn().mockResolvedValue({ sandbox: record }),
      listFiles: vi
        .fn()
        .mockResolvedValueOnce({ sandbox: record, files: [] })
        .mockResolvedValueOnce({
          sandbox: record,
          files: [
            {
              path: "/workspace/outputs/result.txt",
              type: "file",
              sizeBytes: 6,
              updatedAt: new Date(1).toISOString(),
            },
          ],
        }),
      stop: vi.fn().mockResolvedValue({ sandbox: stopped }),
      delete: vi.fn(),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "Done." } }] }),
    );
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    await expect(
      work.run({ prompt: "Create output", cleanup: "delete" }),
    ).rejects.toThrow("requires persistOutput or discardOutputs: true");
    expect(fakeSandboxes.stop).toHaveBeenCalledWith("sb_test");
    expect(fakeSandboxes.delete).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  test("stages durable prior outputs with a structured manifest", async () => {
    const record = sandbox();
    const fakeSandboxes = {
      create: vi.fn().mockResolvedValue(record),
      get: vi.fn().mockResolvedValue(record),
      mkdir: vi.fn().mockResolvedValue({ sandbox: record }),
      uploadFileBase64: vi.fn().mockResolvedValue({ sandbox: record }),
      uploadFile: vi.fn().mockResolvedValue({ sandbox: record }),
      listFiles: vi.fn().mockResolvedValue({ sandbox: record, files: [] }),
    } as unknown as OpenPondSandboxClient;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [{ message: { content: "Revised." } }] }),
    );
    const work = new OpenPondWorkClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.com",
      chatApiBaseUrl: "https://api.example.com/opchat/v1",
      sandboxes: fakeSandboxes,
    });

    await work.run({
      prompt: "Revise the report",
      inputs: [
        {
          id: "output/1",
          name: "quarterly report.docx",
          contentsBase64: "UEsD",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          revision: 2,
          checksumSha256: "abc123",
        },
      ],
    });

    expect(fakeSandboxes.uploadFileBase64).toHaveBeenCalledWith(
      "sb_test",
      "/workspace/inputs/previous-outputs/output-1-quarterly-report.docx",
      "UEsD",
    );
    expect(fakeSandboxes.uploadFile).toHaveBeenCalledWith(
      "sb_test",
      "/workspace/inputs/.openpond-context.json",
      expect.stringContaining('"checksumSha256": "abc123"'),
    );
    fetchMock.mockRestore();
  });
});
