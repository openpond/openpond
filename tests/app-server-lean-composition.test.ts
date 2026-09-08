import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

import {
  AGENT_PROTOCOL_VERSION,
  AgentJsonRpcDispatcher,
} from "@openpond/agent-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { createHarnessSourcePackage } from "@openpond/harness";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { createLocalHarnessWorkspace } from "../apps/server/src/harness/local-harness-workspace-service.js";
import { executeManagedRlWorkTurn } from "../apps/server/src/training/managed-rl-work-turn.js";

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
    const sourceStoreDir = path.join(directory, "source-state");
    const sourceStore = new SqliteStore(sourceStoreDir);
    const { release } = await createLocalHarnessWorkspace({
      store: sourceStore, storeDir: sourceStoreDir, id: "training-source",
      ownerId: "desktop-personal", name: "Training source",
    }).finally(() => sourceStore.close());
    const capturedHarnessSource = createHarnessSourcePackage({
      agentSnapshot: release.agentSnapshot,
      harnessRelease: release.harnessRelease,
      files: new Map(await Promise.all(release.harnessRelease.files.map(async asset => [
        asset.path, await readFile(path.join(release.bundlePath, "source", asset.path)),
      ] as const))),
    });
    let providerRound = 0;
    const server = await createOpenPondAppServer({
      storeDir,
      workspaceDir,
      capturedHarnessSource,
      streamOpenPondHostedChatTurn: async function* (request) {
        expect(JSON.stringify(request)).toContain(release.harnessRelease.contentHash);
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
    const controller = new AbortController();
    let trainingRound = 0;
    const executeTraining = (cancel: boolean) => executeManagedRlWorkTurn({
      workspaceDir, scratchDir: directory, harnessSource: capturedHarnessSource,
      prompt: "Write the training proof.", parentRunId: "deterministic-test",
      maxToolTurns: 4, policyRequest: { deliveryId: "test-delivery", policyVersion: 3 },
      signal: controller.signal,
      async complete(request) {
        expect(JSON.stringify(request.messages)).toContain(release.harnessRelease.contentHash);
        expect(request.deliveryId).toBe("test-delivery");
        if (cancel) controller.abort(new Error("test cancellation"));
        const message = trainingRound++ === 0 || cancel
          ? { content: null, tool_calls: [{ id: "training-exec", type: "function", function: {
              name: "exec_command", arguments: JSON.stringify({
                command: `printf 'training-ok' > ${cancel ? "cancelled-proof.txt" : "training-proof.txt"}`,
                cwd: workspaceDir, timeoutSeconds: 30,
              }),
            } }] }
          : { content: "Training completed." };
        return { response: { choices: [{ message }] }, trainingSample: { round: trainingRound } };
      },
    });
    const trained = await executeTraining(false);
    expect(trained.policyResults).toHaveLength(2);
    expect(trained.policyResult.trainingSample).toEqual({ round: 2 });
    await expect(readFile(path.join(workspaceDir, "training-proof.txt"), "utf8")).resolves.toBe("training-ok");
    await expect(executeTraining(true)).rejects.toThrow("test cancellation");
    await expect(readFile(path.join(workspaceDir, "cancelled-proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).filter(name => name.startsWith("work-attempt-"))).toEqual([]);
    const requestPath = path.join(directory, "work-request.json");
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: "openpond.managedRlWorkRequest.v1", workspaceDir, scratchDir: directory,
      harnessSource: capturedHarnessSource, prompt: "Return a completion.", parentRunId: "transport-test",
      maxToolTurns: 4, timeoutMs: 15_000, policyRequest: { deliveryId: "transport-test" },
    }));
    const messages: Array<Record<string, any>> = [];
    const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/app-server-entry.ts", "--managed-rl-work-request", requestPath], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "policy_request") child.stdin.write(`${JSON.stringify({ id: message.id, result: {
        response: { choices: [{ message: { content: "Transport completed." } }] }, trainingSample: { transport: true },
      } })}\n`);
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(messages.map(message => message.type)).toEqual(["policy_request", "result"]);
    expect(messages[1]?.policyResults[0]?.trainingSample).toEqual({ transport: true });
    expect((await readdir(directory)).filter(name => name.startsWith("work-attempt-"))).toEqual([]);
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

  test("runs hosted Project Actions through the lean app-server", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-lean-app-server-project-action-"),
    );
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let providerRound = 0;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        invocation: {
          id: "invocation_1",
          releaseId: "release_1",
          actionId: "relocation.review_move",
          status: "succeeded",
          resultJson: { reference: "SS-9B3F3C1C" },
          traceJson: [],
          outputJson: [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const previousApiKey = process.env.OPENPOND_API_KEY;
    const previousApiUrl = process.env.OPENPOND_API_URL;
    process.env.OPENPOND_API_KEY = "opk_test";
    process.env.OPENPOND_API_URL = "https://api.openpond.test";
    const server = await createOpenPondAppServer({
      storeDir: path.join(directory, "state"),
      workspaceDir: path.join(directory, "workspace"),
      streamOpenPondHostedChatTurn: async function* () {
        providerRound += 1;
        if (providerRound === 1) {
          yield {
            type: "tool_call_delta",
            toolCalls: [{
              id: "call_review_move",
              type: "function",
              function: {
                name: "openpond_action_run",
                arguments: JSON.stringify({
                  actionId: "relocation.review_move",
                  input: { reference: "SS-9B3F3C1C" },
                }),
              },
            }],
          };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Reviewed the saved move." };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    cleanup.push({
      close: async () => {
        await server.close();
        globalThis.fetch = originalFetch;
        if (previousApiKey === undefined) delete process.env.OPENPOND_API_KEY;
        else process.env.OPENPOND_API_KEY = previousApiKey;
        if (previousApiUrl === undefined) delete process.env.OPENPOND_API_URL;
        else process.env.OPENPOND_API_URL = previousApiUrl;
      },
      directory,
    });

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
          cloudProjectId: "project_1",
          cloudTeamId: "team_1",
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
          prompt: "Review the saved relocation move.",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
          openPondActionCatalog: [{
            id: "relocation.review_move",
            label: "Review move",
            implementation: {
              type: "openpond-hosted-project-action",
              actionId: "relocation.review_move",
              projectId: "project_1",
              teamId: "team_1",
              releaseId: "release_1",
            },
          }],
        },
      },
    });

    expect(resultRecord(turn).turn).toMatchObject({ status: "completed" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain(
      "/v1/project-actions/project_1/actions/relocation.review_move?teamId=team_1",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      input: { reference: "SS-9B3F3C1C" },
      releaseId: "release_1",
      callerType: "work",
    });
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
