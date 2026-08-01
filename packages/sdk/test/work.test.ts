import { describe, expect, test, vi } from "vitest";

import { OpenPondApiError } from "../../cloud/src/api/core.js";
import type { OpenPondSandboxClient } from "../../cloud/src/sandbox/client.js";
import type { SandboxRecord } from "../../cloud/src/sandbox/types/index.js";
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
});
