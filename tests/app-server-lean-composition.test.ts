import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_PROTOCOL_VERSION,
  AgentJsonRpcDispatcher,
} from "@openpond/agent-runtime";
import { afterEach, describe, expect, test } from "vitest";

import {
  APP_SERVER_COMPOSITION,
  createOpenPondAppServer,
} from "../apps/server/src/app-server-runtime";

const cleanup: Array<{
  close(): Promise<void>;
  directory: string;
}> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    await item.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});

describe("lean app-server composition", () => {
  test("boots hosted Work without Local product services and executes in-sandbox tools", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-lean-app-server-"),
    );
    const storeDir = path.join(directory, "state");
    const workspaceDir = path.join(directory, "workspace");
    let providerRound = 0;
    const server = await createOpenPondAppServer({
      storeDir,
      workspaceDir,
      streamOpenPondHostedChatTurn: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            type: "tool_call_delta",
            toolCalls: [
              {
                id: "call_lean_exec",
                type: "function",
                function: {
                  name: "exec_command",
                  arguments: JSON.stringify({
                    command:
                      "printf 'lean-app-server-ok\\n' > lean-app-server-proof.txt",
                    cwd: workspaceDir,
                    timeoutSeconds: 30,
                  }),
                },
              },
            ],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "lean app-server completed" };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    cleanup.push({ close: server.close, directory });

    expect(server.composition).toEqual(APP_SERVER_COMPOSITION);
    expect(server.composition).not.toEqual(
      expect.arrayContaining([
        "http_server",
        "training",
        "compute",
        "scheduler",
        "nested_sandbox",
        "desktop",
      ]),
    );

    const rpc = new AgentJsonRpcDispatcher(server.runtime);
    const initialized = await rpc.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        client: { name: "lean-composition-test", version: "1" },
      },
    });
    expect(resultRecord(initialized).capabilities).toMatchObject({
      placement: "hosted_work",
    });
    await rpc.handle({ jsonrpc: "2.0", method: "initialized" });

    const thread = await rpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
          experience: "work",
          openPondCommandAccessMode: "full-access",
          metadata: { workspaceTarget: "local" },
          cwd: workspaceDir,
          title: "Lean app-server tool execution",
        },
      },
    });
    const threadId = resultRecord(thread).thread.id as string;
    const turn = await rpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: {
          prompt: "Create the app-server proof file.",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      },
    });
    expect(resultRecord(turn).turn).toMatchObject({ status: "completed" });
    await expect(
      readFile(path.join(workspaceDir, "lean-app-server-proof.txt"), "utf8"),
    ).resolves.toBe("lean-app-server-ok\n");

    const capabilities = await rpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "runtime/capabilities",
      params: { threadId },
    });
    expect(resultRecord(capabilities)).toMatchObject({
      placement: "hosted_work",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "exec_command" }),
        expect.objectContaining({ name: "resource_read" }),
        expect.objectContaining({ name: "resource_search" }),
      ]),
    });
  }, 30_000);

  test("forwards hosted Work tools to only the attached remote sandbox", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-lean-app-server-remote-sandbox-"),
    );
    const files = new Map<string, string>();
    const requests: Array<Record<string, unknown>> = [];
    let providerRound = 0;
    const server = await createOpenPondAppServer({
      storeDir: path.join(directory, "state"),
      workspaceDir: path.join(directory, "host-workspace"),
      sandboxRequest: async (action) => {
        requests.push(action as unknown as Record<string, unknown>);
        if (action.type === "get") {
          return {
            sandbox: {
              id: action.sandboxId,
              state: "running",
              status: "running",
            },
          };
        }
        if (action.type === "upload_file") {
          const payload = action.payload as Record<string, unknown>;
          files.set(String(payload.path), String(payload.contents ?? ""));
          return { file: { path: payload.path } };
        }
        if (action.type === "download_file") {
          const payload = action.payload as Record<string, unknown>;
          return {
            file: {
              path: payload.path,
              contentsBase64: Buffer.from(
                files.get(String(payload.path)) ?? "",
                "utf8",
              ).toString("base64"),
            },
          };
        }
        throw new Error(`Unexpected sandbox request: ${action.type}`);
      },
      streamOpenPondHostedChatTurn: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            type: "tool_call_delta",
            toolCalls: [{
              id: "call_remote_write",
              type: "function",
              function: {
                name: "work_write_file",
                arguments: JSON.stringify({
                  area: "outputs",
                  path: "remote-proof.md",
                  content: "# Remote proof\n",
                }),
              },
            }],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        if (providerRound === 2) {
          yield {
            type: "tool_call_delta",
            toolCalls: [{
              id: "call_remote_read",
              type: "function",
              function: {
                name: "work_read_file",
                arguments: JSON.stringify({
                  area: "outputs",
                  path: "remote-proof.md",
                }),
              },
            }],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        if (providerRound === 3) {
          yield {
            type: "tool_call_delta",
            toolCalls: [{
              id: "call_remote_edit",
              type: "function",
              function: {
                name: "work_edit_file",
                arguments: JSON.stringify({
                  area: "outputs",
                  path: "remote-proof.md",
                  oldText: "# Remote proof\n",
                  newText: "# Remote proof\nverified",
                }),
              },
            }],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "remote Work completed" };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    cleanup.push({ close: server.close, directory });

    const rpc = new AgentJsonRpcDispatcher(server.runtime);
    await initializeRpc(rpc);
    const thread = await rpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
          experience: "work",
          workspaceKind: "sandbox",
          workspaceId: "sandbox-attached",
          metadata: { workspaceTarget: "hybrid" },
        },
      },
    });
    const threadId = resultRecord(thread).thread.id as string;
    const turn = await rpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: {
          prompt: "Write and read the proof file in remote compute.",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      },
    });

    expect(resultRecord(turn).turn).toMatchObject({ status: "completed" });
    expect(files.get("outputs/remote-proof.md")).toBe(
      "# Remote proof\nverified\n",
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "get", sandboxId: "sandbox-attached" }),
        expect.objectContaining({
          type: "upload_file",
          sandboxId: "sandbox-attached",
        }),
        expect.objectContaining({
          type: "download_file",
          sandboxId: "sandbox-attached",
        }),
      ]),
    );
    expect(requests.every((request) => request.sandboxId === "sandbox-attached"))
      .toBe(true);
  }, 30_000);

  test("resolves command approval over RPC without an HTTP product host", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-lean-app-server-approval-"),
    );
    const workspaceDir = path.join(directory, "workspace");
    let providerRound = 0;
    const server = await createOpenPondAppServer({
      storeDir: path.join(directory, "state"),
      workspaceDir,
      streamOpenPondHostedChatTurn: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            type: "tool_call_delta",
            toolCalls: [{
              id: "call_approval_exec",
              type: "function",
              function: {
                name: "exec_command",
                arguments: JSON.stringify({
                  command: "printf 'approved\\n' > approval-proof.txt",
                  cwd: workspaceDir,
                }),
              },
            }],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "approved command completed" };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    cleanup.push({ close: server.close, directory });
    const rpc = new AgentJsonRpcDispatcher(server.runtime);
    await initializeRpc(rpc);
    const thread = await rpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
          experience: "work",
          openPondCommandAccessMode: "ask",
          metadata: { workspaceTarget: "local" },
          cwd: workspaceDir,
        },
      },
    });
    const threadId = resultRecord(thread).thread.id as string;
    const approvalId = new Promise<string>((resolve) => {
      server.runtime.subscribe?.((notification) => {
        if (notification.method !== "approval/requested") return;
        const params = notification.params as Record<string, any>;
        resolve(params.data.payload.id as string);
      });
    });
    const pendingTurn = rpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: {
          prompt: "Run the approved proof command.",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      },
    });
    const approval = await approvalId;
    const resolved = await rpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "approval/resolve",
      params: { approvalId: approval, input: { decision: "accept" } },
    });
    expect(resultRecord(resolved).approval).toMatchObject({
      id: approval,
      status: "accepted",
    });
    expect(resultRecord(await pendingTurn).turn).toMatchObject({
      status: "completed",
    });
    await expect(
      readFile(path.join(workspaceDir, "approval-proof.txt"), "utf8"),
    ).resolves.toBe("approved\n");
  }, 30_000);

  test("recovers the same thread and Harness release after process restart", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-lean-app-server-restart-"),
    );
    const storeDir = path.join(directory, "state");
    const workspaceDir = path.join(directory, "workspace");
    let activeServer: Awaited<ReturnType<typeof createOpenPondAppServer>> | null =
      await createOpenPondAppServer({
        storeDir,
        workspaceDir,
        streamOpenPondHostedChatTurn: async function* () {
          yield { type: "text_delta", text: "persisted lean turn" };
          yield { type: "finish", finishReason: "stop" };
        },
      });
    cleanup.push({
      close: async () => {
        await activeServer?.close();
      },
      directory,
    });
    const firstRpc = new AgentJsonRpcDispatcher(activeServer.runtime);
    await initializeRpc(firstRpc);
    const thread = await firstRpc.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "thread/start",
      params: {
        session: {
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
          experience: "work",
          metadata: { workspaceTarget: "local" },
          cwd: workspaceDir,
        },
      },
    });
    const threadId = resultRecord(thread).thread.id as string;
    await firstRpc.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: {
          prompt: "Persist this hosted Work turn.",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      },
    });
    const before = resultRecord(await firstRpc.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "harness/validate",
      params: {},
    }));
    await activeServer.close();
    activeServer = await createOpenPondAppServer({ storeDir, workspaceDir });
    const restartedRpc = new AgentJsonRpcDispatcher(activeServer.runtime);
    await initializeRpc(restartedRpc);
    const resumed = resultRecord(await restartedRpc.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "thread/resume",
      params: { threadId },
    }));
    const after = resultRecord(await restartedRpc.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "harness/validate",
      params: {},
    }));
    expect(resumed.turns).toHaveLength(1);
    expect(resumed.turns[0]).toMatchObject({
      status: "completed",
      prompt: "Persist this hosted Work turn.",
    });
    expect(after.harnessRelease.contentHash).toBe(
      before.harnessRelease.contentHash,
    );
  }, 30_000);
});

async function initializeRpc(rpc: AgentJsonRpcDispatcher): Promise<void> {
  await rpc.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      client: { name: "lean-composition-test", version: "1" },
    },
  });
  await rpc.handle({ jsonrpc: "2.0", method: "initialized" });
}

function resultRecord(response: unknown): Record<string, any> {
  if (!response || typeof response !== "object" || !("result" in response)) {
    throw new Error(`Expected JSON-RPC success: ${JSON.stringify(response)}`);
  }
  return (response as { result: Record<string, any> }).result;
}
