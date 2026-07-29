import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AgentPackageSchema,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { createWorkAgentPackageService } from "../apps/server/src/work/work-agent-package-service";
import { loadGlobalConfig, saveConfig } from "../packages/cloud/src/config";
import {
  initLocalProfileRepo,
  installAgentPackageIntoActiveProfile,
} from "../packages/cloud/src/profile/local-profile";

describe("Work Agent package service", () => {
  test("prepares the SDK in a projectless Work sandbox", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-agent-")
    );
    const requests: Array<Record<string, unknown>> = [];
    const archive = Buffer.from("agent sdk archive");
    const service = createWorkAgentPackageService({
      deviceId: "device_test",
      storeDir,
      runtimeEventsForSession: async () => [],
      loadAgentSdkArchive: async () => archive,
      sandboxRequest: async (request) => {
        requests.push(request as unknown as Record<string, unknown>);
        return request.type === "exec"
          ? { command: { status: "completed", exitCode: 0 } }
          : { file: { path: "inputs/openpond-agent-sdk.tgz" } };
      },
    });

    try {
      await expect(
        service.prepareWorkAgent({
          session: workSession(),
          directory: "customer-replies",
          template: "customer-reply-agent",
        })
      ).resolves.toMatchObject({
        directory: "customer-replies",
        template: "customer-reply-agent",
      });
      expect(requests[0]).toMatchObject({
        type: "upload_file",
        sandboxId: "sandbox_work",
        payload: {
          path: "inputs/openpond-agent-sdk.tgz",
          contentsBase64: archive.toString("base64"),
        },
      });
      expect(requests[1]).toMatchObject({
        type: "exec",
        sandboxId: "sandbox_work",
        payload: {
          command: expect.stringContaining(
            "npx openpond-agent init customer-reply-agent --cwd customer-replies"
          ),
        },
      });
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("rejects a sandbox that acknowledges commands without executing them", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-agent-")
    );
    const service = createWorkAgentPackageService({
      deviceId: "device_test",
      storeDir,
      runtimeEventsForSession: async () => [],
      loadAgentSdkArchive: async () => Buffer.from("agent sdk archive"),
      sandboxRequest: async (request) =>
        request.type === "exec"
          ? {
              command: {
                status: "succeeded",
                exitCode: 0,
                output:
                  "[poc-runner] command accepted by simulated-firecracker driver\n[poc-runner] no host command was executed",
              },
            }
          : { file: { path: "inputs/openpond-agent-sdk.tgz" } },
    });

    try {
      await expect(
        service.prepareWorkAgent({
          session: workSession(),
          directory: "agent",
          template: "blank-agent",
        })
      ).rejects.toThrow("requires an execution-backed Work sandbox");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("runs SDK gates and saves deterministic content-addressed packages", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-agent-")
    );
    const source = agentSourceFiles();
    const events: RuntimeEvent[] = [];
    const requests: Array<{
      type: string;
      sandboxId?: string;
      payload?: unknown;
    }> = [];
    const requestSource = sandboxRequestForSource(source);
    const service = createWorkAgentPackageService({
      deviceId: "device_test",
      storeDir,
      runtimeEventsForSession: async () => events,
      loadAgentSdkArchive: async () => Buffer.from("unused"),
      sandboxRequest: async (request) => {
        requests.push(request);
        return requestSource(request);
      },
    });

    try {
      const first = await service.saveWorkAgentPackage({
        session: workSession(),
        sourceTurnId: "turn_1",
        directory: "agent",
        title: "Customer Reply Agent",
      });
      events.push(runtimeEvent(first.outputRef));
      const second = await service.saveWorkAgentPackage({
        session: workSession(),
        sourceTurnId: "turn_2",
        directory: "agent",
        title: "Customer Reply Agent",
      });

      expect(first.outputRef).toMatchObject({
        kind: "agent_package",
        agentId: "customer-reply-agent",
        title: "Customer Reply Agent",
        revision: 1,
        actions: [
          {
            id: "draft_reply",
            label: "Draft reply",
            inputSchema: {
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
            },
          },
        ],
        runtimeRequirements: {
          base: "node-bun-workspace",
          modelPolicy: { provider: "openpond-managed" },
        },
        validation: [
          { status: "passed", label: "Agent SDK validation passed" },
          { status: "passed", label: "Agent SDK eval publish gate passed" },
        ],
      });
      expect(first.outputRef.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(first.outputRef.versionId).toBe(
        `agent-${first.outputRef.digest.slice(0, 20)}`
      );
      expect(second.outputRef.id).toBe(first.outputRef.id);
      expect(second.outputRef.revision).toBe(2);
      expect(second.outputRef.digest).toBe(first.outputRef.digest);
      expect(second.outputRef.location.path).toBe(
        first.outputRef.location.path
      );
      expect(requests[0]).toMatchObject({
        type: "exec",
        sandboxId: "sandbox_work",
        payload: {
          timeoutSeconds: 900,
          command: expect.stringContaining("openpond-agent eval"),
        },
      });

      const stored = AgentPackageSchema.parse(
        JSON.parse(await readFile(first.outputRef.location.path, "utf8"))
      );
      expect(stored.digest).toBe(first.outputRef.digest);
      expect(stored.versionId).toBe(first.outputRef.versionId);
      expect(stored.receipts.map((receipt) => receipt.kind)).toEqual([
        "sdk_validation",
        "sdk_eval",
      ]);
      const packageJson = stored.source.files.find(
        (file) => file.path === "package.json"
      );
      expect(
        JSON.parse(
          Buffer.from(packageJson!.contentsBase64, "base64").toString("utf8")
        ).dependencies["openpond-agent-sdk"]
      ).toBe("0.0.0");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("rejects a failed eval gate and files outside the Agent root", async () => {
    const storeDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-agent-")
    );
    try {
      const failed = agentSourceFiles({
        evalResults: {
          schema: "openpond.agent.eval-results.v1",
          publishGate: { status: "failed" },
          summary: { total: 1, passed: 0, failed: 1 },
        },
      });
      const failedService = createWorkAgentPackageService({
        deviceId: "device_test",
        storeDir,
        runtimeEventsForSession: async () => [],
        loadAgentSdkArchive: async () => Buffer.from("unused"),
        sandboxRequest: sandboxRequestForSource(failed),
      });
      await expect(
        failedService.saveWorkAgentPackage({
          session: workSession(),
          sourceTurnId: "turn_1",
          directory: "agent",
        })
      ).rejects.toThrow("publish gate did not pass");

      const escapingService = createWorkAgentPackageService({
        deviceId: "device_test",
        storeDir,
        runtimeEventsForSession: async () => [],
        loadAgentSdkArchive: async () => Buffer.from("unused"),
        sandboxRequest: async (request) => {
          if (request.type === "exec") {
            return { command: { status: "completed", exitCode: 0 } };
          }
          if (request.type === "list_files") {
            return {
              files: [
                {
                  type: "file",
                  path: "work/another-agent/secret.txt",
                },
              ],
            };
          }
          throw new Error("Unexpected request");
        },
      });
      await expect(
        escapingService.saveWorkAgentPackage({
          session: workSession(),
          sourceTurnId: "turn_1",
          directory: "agent",
        })
      ).rejects.toThrow("outside the Agent source root");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("installs a reviewed package into the active Agent profile", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-work-agent-install-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      await saveConfig({});
      const repoPath = path.join(tempRoot, "profile");
      await initLocalProfileRepo({
        repoPath,
        profile: "default",
        template: "blank-profile",
      });
      const service = createWorkAgentPackageService({
        deviceId: "device_test",
        storeDir: path.join(tempRoot, "store"),
        runtimeEventsForSession: async () => [],
        loadAgentSdkArchive: async () => Buffer.from("unused"),
        sandboxRequest: sandboxRequestForSource(agentSourceFiles()),
      });
      const saved = await service.saveWorkAgentPackage({
        session: workSession(),
        sourceTurnId: "turn_install",
        directory: "agent",
        title: "Customer Reply Agent",
      });
      const agentPackage = AgentPackageSchema.parse(
        JSON.parse(await readFile(saved.outputRef.location.path, "utf8"))
      );

      const installed = await installAgentPackageIntoActiveProfile({
        agentPackage,
      });
      expect(installed).toMatchObject({
        agentId: "customer-reply-agent",
        versionId: agentPackage.versionId,
        digest: agentPackage.digest,
        state: {
          agents: [
            {
              id: "customer-reply-agent",
              name: "Customer Reply Agent",
              enabled: true,
            },
          ],
          actionCatalog: [
            {
              id: "draft_reply",
              trace: {
                agentVersionId: agentPackage.versionId,
                agentPackageDigest: agentPackage.digest,
              },
            },
          ],
        },
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(
              repoPath,
              "profiles/default/agents/customer-reply-agent/.openpond/agent-package-origin.json"
            ),
            "utf8"
          )
        )
      ).toMatchObject({
        versionId: agentPackage.versionId,
        digest: agentPackage.digest,
      });
      await expect(
        installAgentPackageIntoActiveProfile({ agentPackage })
      ).rejects.toThrow("already exists");
      await expect(
        installAgentPackageIntoActiveProfile({
          agentPackage,
          overwrite: true,
        })
      ).resolves.toMatchObject({ versionId: agentPackage.versionId });
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function sandboxRequestForSource(source: Map<string, Buffer>) {
  return async (request: {
    type: string;
    sandboxId?: string;
    payload?: unknown;
  }) => {
    if (request.type === "exec") {
      return { command: { status: "completed", exitCode: 0 } };
    }
    if (request.type === "list_files") {
      return {
        files: [...source.keys()].map((filePath) => ({
          type: "file",
          path: `work/agent/${filePath}`,
          sizeBytes: source.get(filePath)!.byteLength,
        })),
      };
    }
    if (request.type === "download_file") {
      const payload = request.payload as { path: string };
      const filePath = payload.path.replace(/^work\/agent\//, "");
      const bytes = source.get(filePath);
      if (!bytes) throw new Error(`Missing source fixture ${filePath}`);
      return {
        file: {
          contentsBase64: bytes.toString("base64"),
          totalSizeBytes: bytes.byteLength,
          truncated: false,
        },
      };
    }
    throw new Error(`Unexpected sandbox request ${request.type}`);
  };
}

function agentSourceFiles(input?: {
  evalResults?: Record<string, unknown>;
}): Map<string, Buffer> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "customer-reply-agent",
      version: "0.1.0",
      dependencies: {
        "openpond-agent-sdk":
          "file:/workspace/work/node_modules/openpond-agent-sdk",
      },
    }),
    "agent/agent.ts": "export const agent = { id: 'customer-reply-agent' };\n",
    ".openpond/agent-manifest.json": JSON.stringify({
      schema: "openpond.agent.manifest.v1",
      project: { name: "customer-reply-agent", version: "0.1.0" },
      runtime: { base: "node-bun-workspace" },
      resources: { memory: "512Mi" },
      modelPolicy: { provider: "openpond-managed" },
      setup: null,
      inputSchemas: {
        DraftReplyInput: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" } },
        },
      },
    }),
    ".openpond/action-registry.json": JSON.stringify({
      schema: "openpond.agent.action-registry.v1",
      actions: [
        {
          id: "draft_reply",
          label: "Draft reply",
          description: "Draft a customer reply.",
          inputSchema: "DraftReplyInput",
          outputSchema: { type: "object" },
          schedulePolicy: { enabled: true },
        },
      ],
    }),
    ".openpond/eval-results.json": JSON.stringify(
      input?.evalResults ?? {
        schema: "openpond.agent.eval-results.v1",
        publishGate: { status: "passed" },
        summary: { total: 2, passed: 2, failed: 0 },
      }
    ),
    ".openpond/validator-report.md": "# Validation\n\nAll checks passed.\n",
  };
  return new Map(
    Object.entries(files).map(([filePath, contents]) => [
      filePath,
      Buffer.from(contents),
    ])
  );
}

function runtimeEvent(outputRef: unknown): RuntimeEvent {
  return {
    id: "event_agent_package",
    sessionId: "session_work",
    turnId: "turn_1",
    name: "workspace_action",
    timestamp: "2026-07-28T20:00:00.000Z",
    source: "chat_action",
    action: "sandbox_save_agent_package",
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
    title: "Build an Agent",
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
    status: "running",
    createdAt: "2026-07-28T19:00:00.000Z",
    updatedAt: "2026-07-28T19:00:00.000Z",
    metadata: {},
  };
}
