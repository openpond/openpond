import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  loadGlobalConfig,
  saveConfig,
  type LocalOpenPondProfileCheckStatus,
  type LocalOpenPondProfilePushStatus,
} from "../packages/cloud/src/config";
import {
  OpenPondProfileSetupRequiredError,
  assertOpenPondProfileActionReady,
  buildOpenPondProfileSetupGate,
  hostedPublishStatusFromPayload,
  hostedRunStatusFromRunSummary,
  hostedRunSummaryFromPayload,
  hostedSourceCheckStatusFromPayload,
  initLocalProfileRepo,
  loadLocalProfileRepo,
  mergeActiveLocalProfileConfig,
  mergeProfileRepoManifestEntry,
  runProfileCheck,
  runProfileSdkCommand,
} from "../packages/cloud/src/profile/local-profile";

describe("local profile control invariants", () => {
  test("repeat init preserves enabled agents on an existing profile manifest entry", () => {
    expect(
      mergeProfileRepoManifestEntry(
        {
          path: "profiles/default",
          defaultAgent: "default",
          enabledAgents: ["default", "phase5-reporter"],
        },
        "profiles/default",
      ),
    ).toEqual({
      path: "profiles/default",
      defaultAgent: "default",
      enabledAgents: ["default", "phase5-reporter"],
    });
  });

  test("repeat init enables the existing default agent when enabledAgents is missing", () => {
    expect(
      mergeProfileRepoManifestEntry(
        {
          path: "profiles/support",
          defaultAgent: "support",
        },
        "profiles/support",
      ),
    ).toEqual({
      path: "profiles/support",
      defaultAgent: "support",
      enabledAgents: ["support"],
    });
  });

  test("loading the same profile preserves local check and hosted push status", () => {
    const lastCheck: LocalOpenPondProfileCheckStatus = {
      command: "eval",
      status: "passed",
      checkedAt: "2026-06-29T16:58:06.861Z",
      exitCode: 0,
      sourceHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
    };
    const lastPush: LocalOpenPondProfilePushStatus = {
      status: "pushed",
      pushedAt: "2026-06-28T18:13:28.572Z",
      teamId: "team_123",
      projectId: "project_123",
      localHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
      hostedHead: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
      sourceRef: "main",
      promotionStatus: "hosted_run_pending",
      hostedRunStatus: "running",
      hostedRunAgentId: "agent_123",
      hostedRunId: "run_123",
      hostedRunAt: "2026-06-28T18:14:28.572Z",
      hostedSourceMaterialization: {
        status: "uploaded",
        agentId: "agent_123",
        projectId: "project_123",
        sourceRoot: "/workspace/profile-repo/profiles/default/agents/agent_123",
        sourceRef: "main",
        sourceCommitSha: "source_sha_123",
        manifestHash: "manifest_hash_123",
        manifestPath: "openpond.yaml",
        manifestSyncedAt: "2026-06-28T18:14:00.572Z",
        fileCount: 12,
        totalBytes: 3456,
        generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
        synthesizedOpenPondYaml: true,
        uploadMetadataPath: ".openpond/source-upload-metadata.json",
        setupCommands: ["bun install"],
        validationCommands: ["openpond-agent validate"],
        materializedAt: "2026-06-28T18:14:01.572Z",
      },
      hostedSourceCheck: {
        status: "requested",
        agentId: "agent_123",
        workItemId: "work_item_123",
        deployPlanStatus: "ready",
        canRun: true,
        canDeploy: true,
        sourceRef: "main",
        sourceCommitSha: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
        manifestHash: "manifest_hash_123",
        setupCommands: ["bun install"],
        validationCommands: ["openpond-agent validate"],
        requiredChecks: ["openpond-agent validate"],
        evalNames: ["support-items"],
        blockedReasons: [],
        staleReasons: [],
        runtimeId: "runtime_123",
        sandboxId: "sandbox_123",
      },
      hostedPublish: {
        status: "published",
        agentId: "agent_123",
        snapshotId: "snapshot_123",
        sourceRef: "main",
        sourceCommitSha: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
        manifestHash: "manifest_hash_123",
        buildStatus: "passed",
        validationStatus: "passed",
        evalStatus: "passed",
        publishedAt: "2026-06-28T18:14:20.572Z",
      },
      hostedRun: {
        status: "running",
        agentId: "agent_123",
        runId: "run_123",
        runtimeId: "runtime_123",
        sandboxId: "sandbox_123",
        sourceRef: "main",
        sourceCommitSha: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
        manifestHash: "manifest_hash_123",
        setupGateStatus: "ready",
        setupRequirementRefs: ["action_catalog:agent_123.chat:integration:fixtures"],
        traceArtifactRefs: ["artifacts/trace.jsonl"],
      },
    };

    expect(
      mergeActiveLocalProfileConfig(
        {
          repoPath: "/workspace/profile-repo",
          profile: "default",
          mode: "local",
          lastCheck,
          lastPush,
        },
        "/workspace/profile-repo",
        "default",
      ),
    ).toEqual({
      repoPath: "/workspace/profile-repo",
      profile: "default",
      mode: "local",
      lastCheck,
      lastPush,
    });
  });

  test("loading a different profile drops stale check and push status", () => {
    expect(
      mergeActiveLocalProfileConfig(
        {
          repoPath: "/workspace/profile-repo",
          profile: "default",
          mode: "local",
          lastPush: {
            status: "pushed",
            pushedAt: "2026-06-28T18:13:28.572Z",
            projectId: "project_123",
          },
        },
        "/workspace/profile-repo",
        "support",
      ),
    ).toEqual({
      repoPath: "/workspace/profile-repo",
      profile: "support",
      mode: "local",
    });
  });

  test("extracts hosted promotion evidence from source check, publish, and run payloads", () => {
    const sourceCheck = hostedSourceCheckStatusFromPayload({
      agentId: "agent_123",
      status: "requested",
      checkResult: {
        workItem: { id: "work_item_123" },
        deployPlan: {
          status: "ready",
          canRun: true,
          canDeploy: true,
          blockedReasons: [],
          staleReasons: [],
          source: {
            sourceRef: "main",
            sourceCommitSha: "sha_123",
            manifestHash: "manifest_hash_123",
            manifestPath: "openpond.yaml",
          },
          checks: {
            setupCommands: ["bun install"],
            validationCommands: ["openpond-agent validate"],
            requiredChecks: ["openpond-agent validate"],
            evalNames: ["support-items"],
          },
        },
        sourceCheckStatus: {
          latestRuntimeId: "runtime_123",
          latestSandboxId: "sandbox_123",
          traceArtifactRefs: ["artifacts/trace.jsonl"],
        },
      },
    });
    const publish = hostedPublishStatusFromPayload({
      agentId: "agent_123",
      publishResult: {
        activeManifestSnapshot: {
          id: "snapshot_123",
          sourceRef: "main",
          sourceCommitSha: "sha_123",
          manifestHash: "manifest_hash_123",
          manifestPath: "openpond.yaml",
          buildStatus: "passed",
          validationStatus: "passed",
          evalStatus: "passed",
        },
        publishedAt: "2026-07-02T12:00:00.000Z",
      },
    });
    const run = hostedRunSummaryFromPayload({
      agentId: "agent_123",
      runResult: {
        run: {
          id: "run_123",
          agentId: "agent_123",
          status: "succeeded",
          runtimeId: "runtime_123",
          sandboxId: "sandbox_123",
          runtimeSource: {
            sourceRef: "main",
            sourceCommitSha: "sha_123",
          },
          metadata: {
            sourceSummary: { manifestHash: "manifest_hash_123" },
            setupGate: {
              status: "ready",
              requirements: [{ ref: "setup:fixtures" }],
            },
            traceSummary: { artifactRefs: ["artifacts/trace.jsonl"] },
            evalSummary: { artifactRefs: ["artifacts/eval.json"] },
          },
          createdAt: "2026-07-02T12:01:00.000Z",
          completedAt: "2026-07-02T12:02:00.000Z",
        },
      },
    });

    expect(sourceCheck).toMatchObject({
      status: "requested",
      workItemId: "work_item_123",
      manifestHash: "manifest_hash_123",
      setupCommands: ["bun install"],
      runtimeId: "runtime_123",
      sandboxId: "sandbox_123",
    });
    expect(publish).toMatchObject({
      status: "published",
      snapshotId: "snapshot_123",
      validationStatus: "passed",
    });
    expect(run).toMatchObject({
      status: "succeeded",
      runId: "run_123",
      runtimeId: "runtime_123",
      sandboxId: "sandbox_123",
      manifestHash: "manifest_hash_123",
      setupGateStatus: "ready",
      setupRequirementRefs: ["setup:fixtures"],
    });
    expect(hostedRunStatusFromRunSummary(run)).toBe("passed");
  });

  test("profile setup gate blocks required unresolved action setup", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [
            {
              kind: "integration",
              name: "slack",
              required: true,
              status: "setup_required",
            },
            {
              kind: "external_service",
              name: "weather",
              required: false,
              status: "setup_required",
            },
          ],
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "setup_required",
      requirementCount: 2,
      blockingCount: 1,
      optionalMissingCount: 1,
    });
    expect(gate.blockingRequirements).toMatchObject([
      {
        actionId: "chat",
        kind: "integration",
        label: "slack",
        status: "setup_required",
        required: true,
        blocking: true,
      },
    ]);
    let thrown: unknown;
    try {
      assertOpenPondProfileActionReady("chat", gate);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenPondProfileSetupRequiredError);
    if (!(thrown instanceof OpenPondProfileSetupRequiredError)) {
      throw new Error("expected structured setup-required error");
    }
    expect(thrown.code).toBe("agent_source_setup_required");
    expect(thrown.details).toMatchObject({
      error: "agent_source_setup_required",
      actionId: "chat",
      missing: ["slack"],
      setupGate: {
        status: "setup_required",
        blockingCount: 1,
      },
      blockingSetupRequirements: [
        {
          actionId: "chat",
          kind: "integration",
          label: "slack",
          required: true,
          status: "setup_required",
          blocking: true,
        },
      ],
      setupRequirements: [
        {
          actionId: "chat",
          kind: "integration",
          label: "slack",
          required: true,
          status: "setup_required",
          blocking: true,
        },
        {
          actionId: "chat",
          kind: "external_service",
          label: "weather",
          required: false,
          status: "setup_required",
          blocking: false,
        },
      ],
    });
  });

  test("profile setup gate treats optional missing rows as visible but non-blocking", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [
            {
              kind: "runtime_tool",
              tool: "ffmpeg",
              required: false,
              status: "setup_required",
            },
          ],
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "ready",
      requirementCount: 1,
      blockingCount: 0,
      optionalMissingCount: 1,
    });
    expect(() => assertOpenPondProfileActionReady("chat", gate)).not.toThrow();
  });

  test("profile setup gate treats required ready rows as non-blocking", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [
            {
              kind: "channel",
              name: "openpond_chat",
              required: true,
              status: "ready",
              satisfied: true,
            },
            {
              kind: "volume",
              name: "committed-local-invoice-fixtures",
              required: true,
              status: "ready",
              satisfied: true,
            },
          ],
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "ready",
      requirementCount: 2,
      blockingCount: 0,
      readyCount: 2,
    });
    expect(() => assertOpenPondProfileActionReady("chat", gate)).not.toThrow();
  });

  test("profile setup gate applies source-upload setup rows to local activation", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [{ id: "chat", setupRequirements: [] }],
      sourceSetupRequirements: [
        {
          kind: "runtime_tool",
          tool: "libreoffice",
          required: true,
          status: "blocked",
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "blocked",
      blockingCount: 1,
    });
    expect(gate.blockingRequirements[0]).toMatchObject({
      actionId: null,
      kind: "runtime_tool",
      label: "libreoffice",
      status: "blocked",
    });
    let thrown: unknown;
    try {
      assertOpenPondProfileActionReady("chat", gate);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenPondProfileSetupRequiredError);
    if (!(thrown instanceof OpenPondProfileSetupRequiredError)) {
      throw new Error("expected structured setup-required error");
    }
    expect(thrown.details).toMatchObject({
      error: "agent_source_setup_required",
      actionId: "chat",
      missing: ["libreoffice"],
      blockingSetupRequirements: [
        {
          actionId: null,
          kind: "runtime_tool",
          label: "libreoffice",
          status: "blocked",
          required: true,
          blocking: true,
        },
      ],
    });
  });

  test("profile run fails before SDK execution when required setup is unresolved", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-gate-"));
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const sourcePath = path.join(repoPath, "profiles", "default");
      const agentPath = path.join(sourcePath, "agents", "needs-setup");
      await mkdir(path.join(agentPath, ".openpond"), { recursive: true });
      await writeFile(
        path.join(repoPath, "openpond-profile.json"),
        JSON.stringify(
          {
            schema: "openpond.profileRepo.v1",
            defaultProfile: "default",
            profiles: {
              default: {
                path: "profiles/default",
                defaultAgent: "needs-setup",
                enabledAgents: ["needs-setup"],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(agentPath, ".openpond", "agent-manifest.json"),
        JSON.stringify(
          {
            schema: "openpond.agent.manifest.v1",
            actions: [
              {
                id: "chat",
                label: "Chat",
                description: "Requires unresolved setup.",
                setupRequirements: [
                  {
                    kind: "env",
                    name: "SUPPORT_API_KEY",
                    required: true,
                    status: "setup_required",
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(agentPath, ".openpond", "action-registry.json"),
        JSON.stringify(
          {
            schema: "openpond.agent.actionRegistry.v1",
            actions: [
              {
                id: "chat",
                label: "Chat",
                description: "Requires unresolved setup.",
                setupRequirements: [
                  {
                    kind: "env",
                    name: "SUPPORT_API_KEY",
                    required: true,
                    status: "setup_required",
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const state = await loadLocalProfileRepo(repoPath, "default");
      expect(state.setupGate).toMatchObject({
        status: "setup_required",
        requirementCount: 1,
        blockingCount: 1,
      });

      let thrown: unknown;
      try {
        await runProfileSdkCommand({
          command: "run",
          args: ["chat", "--input", JSON.stringify({ prompt: "hello", channel: "openpond_chat" })],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(OpenPondProfileSetupRequiredError);
      if (!(thrown instanceof OpenPondProfileSetupRequiredError)) {
        throw new Error("expected structured setup-required error");
      }
      expect(thrown.details).toMatchObject({
        error: "agent_source_setup_required",
        actionId: "chat",
        missing: ["SUPPORT_API_KEY"],
        setupGate: {
          status: "setup_required",
          blockingCount: 1,
        },
        blockingSetupRequirements: [
          {
            actionId: "chat",
            kind: "env",
            label: "SUPPORT_API_KEY",
            required: true,
            status: "setup_required",
            blocking: true,
          },
        ],
      });
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile check validates every enabled profile agent source", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-check-all-"));
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const sourcePath = path.join(repoPath, "profiles", "default");
      await initLocalProfileRepo({ repoPath, profile: "default" });

      const invalidAgentId = "invalid-enabled-agent";
      const invalidAgentPath = path.join(sourcePath, "agents", invalidAgentId);
      await mkdir(invalidAgentPath, { recursive: true });
      await writeFile(
        path.join(invalidAgentPath, "agent.ts"),
        "export const invalidEnabledAgent = true;\n",
        "utf8",
      );

      const manifestPath = path.join(repoPath, "openpond-profile.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        profiles: Record<string, { enabledAgents?: string[] }>;
      };
      manifest.profiles.default.enabledAgents = ["default", invalidAgentId];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await writeFile(
        path.join(sourcePath, "settings", "profile.yaml"),
        [
          "schema: openpond.profile.v1",
          "profile: default",
          "agents:",
          "  - id: default",
          "    path: agent/agent.ts",
          "    enabled: true",
          `  - id: ${invalidAgentId}`,
          `    path: agents/${invalidAgentId}`,
          "    enabled: true",
          "",
        ].join("\n"),
        "utf8",
      );

      const state = await loadLocalProfileRepo(repoPath, "default");
      expect(state.catalog.stale).toBe(true);
      expect(state.catalog.error).toContain(`Profile agent ${invalidAgentId}`);
      expect(state.catalog.error).toContain(".openpond/agent-manifest.json");

      let thrown: unknown;
      try {
        await runProfileCheck("inspect");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      if (!(thrown instanceof Error)) {
        throw new Error("expected profile check to fail for the invalid enabled source");
      }
      expect(thrown.message).toContain(`enabled agent ${invalidAgentId}`);
      expect(thrown.message).toContain("agent/agent.ts or openpond.yaml is required");
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
