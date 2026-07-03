import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { createOpenPondSandboxClient } from "../src/sandbox/client";
import { collectProfileSourceUploadForPush } from "../src/cli/profile";
import {
  AGENT_SDK_PILOT_NAMES,
  LARGE_RAW_MARKER,
  type CapturedRequest,
  rewriteAgentSdkDependencyForTest,
  resolveTestAgentSdkRoot,
  runCli,
  runDependencySetupFromUploadMetadata,
  runTestCommand,
  runTestCommandWithOutput,
  withSandboxApi,
  writeAgentSdkUploadFixture,
  writeSourceUploadEntriesToDirectory,
} from "./cli-sandbox-fixture";

const longCliScenarioTest =
  process.env.OPENPOND_SKIP_CI_LONG_CLI_TESTS === "1" ? test.skip : test;

describe("project and agent sandbox CLI scenarios", () => {
  longCliScenarioTest("project and agent commands use first-class sandbox API resources", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const projectList = await runCli([
        "project",
        "list",
        "--team-id",
        "team_test",
        "--json",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const projectCreate = await runCli([
        "project",
        "create",
        "--team-id",
        "team_test",
        "--name",
        "Demo Project",
        "--source-type",
        "internal_repo",
        "--git-owner",
        "openpond",
        "--git-repo",
        "demo-project",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const projectUpdate = await runCli([
        "project",
        "update",
        "project_test",
        "--team-id",
        "team_test",
        "--description",
        "Updated Project",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentCreate = await runCli([
        "agent",
        "create",
        "--team-id",
        "team_test",
        "--project-id",
        "project_test",
        "--name",
        "Daily Report",
        "--entrypoint-scope",
        "action",
        "--entrypoint-name",
        "hello",
        "--trigger-type",
        "manual",
        "--workflow-mode",
        "attempt",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentUpdate = await runCli([
        "agent",
        "update",
        "agent_test",
        "--team-id",
        "team_test",
        "--trigger-type",
        "background",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentRun = await runCli([
        "agent",
        "run",
        "agent_test",
        "--team-id",
        "team_test",
        "--idempotency-key",
        "run_key",
        "--conversation-id",
        "session_run_1",
        "--target-project-id",
        "target_project_test",
        "--input",
        '{"message":"hello"}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentBindSource = await runCli([
        "agent",
        "bind-source",
        "agent_test",
        "--team-id",
        "team_test",
        "--source-mode",
        "published_snapshot",
        "--published-snapshot-id",
        "snapshot_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentSourceDeployPlan = await runCli([
        "agent",
        "source",
        "deploy-plan",
        "agent_test",
        "--team-id",
        "team_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentSourceChecks = await runCli([
        "agent",
        "source",
        "checks",
        "agent_test",
        "--team-id",
        "team_test",
        "--check-kind",
        "validate",
        "--source-ref",
        "master",
        "--source-check-dispatch",
        "coding_core",
        "--metadata",
        '{"reason":"phase3"}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentSourceSnapshots = await runCli([
        "agent",
        "source",
        "manifest-snapshots",
        "agent_test",
        "--team-id",
        "team_test",
        "--limit",
        "2",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentSourcePublish = await runCli([
        "agent",
        "source",
        "publish",
        "agent_test",
        "--team-id",
        "team_test",
        "--expected-manifest-hash",
        "hash_test",
        "--work-item-id",
        "work_item_test",
        "--eval-status",
        "passed",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditOpen = await runCli([
        "agent",
        "edit",
        "open",
        "agent_test",
        "--team-id",
        "team_test",
        "--project-id",
        "project_test",
        "--message",
        "Update the agent",
        "--source-ref",
        "draft/ref",
        "--base-sha",
        "base_sha_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditChat = await runCli([
        "agent",
        "edit",
        "chat",
        "work_item_test",
        "--team-id",
        "team_test",
        "--message",
        "Please update copy",
        "--payload",
        '{"mode":"builder"}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditActivity = await runCli([
        "agent",
        "edit",
        "activity",
        "work_item_test",
        "--team-id",
        "team_test",
        "--limit",
        "2",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditBackground = await runCli([
        "agent",
        "edit",
        "background",
        "work_item_test",
        "--team-id",
        "team_test",
        "--prompt",
        "Run checks",
        "--agent-edit",
        '{"policyDiscovery":{"command":"openpond agent inspect --json","runAfter":"source-materialized"},"requiredChecks":["openpond agent validate"]}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditRequestChecks = await runCli([
        "agent",
        "edit",
        "request-checks",
        "agent_test",
        "--team-id",
        "team_test",
        "--check-kind",
        "eval",
        "--source-ref",
        "draft/ref",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentSourceCheckStatus = await runCli([
        "agent",
        "source",
        "check-status",
        "work_item_test",
        "--team-id",
        "team_test",
        "--limit",
        "2",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditCheckStatus = await runCli([
        "agent",
        "edit",
        "check-status",
        "work_item_test",
        "--team-id",
        "team_test",
        "--limit",
        "2",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditFailedSetupStatus = await runCli([
        "agent",
        "edit",
        "check-status",
        "work_item_failed_setup",
        "--team-id",
        "team_test",
        "--limit",
        "2",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditCheckpointResult = await runCli([
        "agent",
        "edit",
        "checkpoint-result",
        "work_item_test",
        "--team-id",
        "team_test",
        "--ref",
        "source_ref_test",
        "--metadata",
        '{"sourceHash":"hash_test"}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditCommitResult = await runCli([
        "agent",
        "edit",
        "commit-result",
        "work_item_test",
        "--team-id",
        "team_test",
        "--ref",
        "commit_ref_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const agentEditPrResult = await runCli([
        "agent",
        "edit",
        "pr-result",
        "work_item_test",
        "--team-id",
        "team_test",
        "--ref",
        "pr_ref_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(projectList.code).toBe(0);
      expect(projectCreate.code).toBe(0);
      expect(projectUpdate.code).toBe(0);
      expect(agentCreate.code).toBe(0);
      expect(agentUpdate.code).toBe(0);
      expect(agentRun.code).toBe(0);
      expect(agentBindSource.code).toBe(0);
      expect(agentSourceDeployPlan.code).toBe(0);
      expect(agentSourceChecks.code).toBe(0);
      expect(agentSourceSnapshots.code).toBe(0);
      expect(agentSourcePublish.code).toBe(0);
      expect(agentEditOpen.code).toBe(0);
      expect(agentEditChat.code).toBe(0);
      expect(agentEditActivity.code).toBe(0);
      expect(agentEditBackground.code).toBe(0);
      expect(agentEditRequestChecks.code).toBe(0);
      expect(agentSourceCheckStatus.code).toBe(0);
      expect(agentEditCheckpointResult.code).toBe(0);
      expect(agentEditCommitResult.code).toBe(0);
      expect(agentEditPrResult.code).toBe(0);
      expect(JSON.parse(projectList.stdout).projects[0]).toMatchObject({
        id: "project_test",
        teamId: "team_test",
      });
      expect(JSON.parse(projectCreate.stdout).project).toMatchObject({
        id: "project_test",
        sourceType: "internal_repo",
      });
      expect(JSON.parse(projectUpdate.stdout).project).toMatchObject({
        id: "project_test",
        description: "Updated Project",
      });
      expect(JSON.parse(agentCreate.stdout).agent).toMatchObject({
        id: "agent_test",
        projectId: "project_test",
        selectedEntrypoint: { scope: "action", name: "hello" },
      });
      expect(JSON.parse(agentUpdate.stdout).agent).toMatchObject({
        id: "agent_test",
        triggerType: "background",
      });
      expect(JSON.parse(agentRun.stdout).run).toMatchObject({
        id: "agent_run_test",
        agentId: "agent_test",
        runtimeId: "workspace_test",
      });
      expect(JSON.parse(agentBindSource.stdout).agentSource).toMatchObject({
        mode: "published_snapshot",
        publishedSnapshotId: "snapshot_test",
      });
      expect(
        JSON.parse(agentSourceDeployPlan.stdout).deployPlan
      ).toMatchObject({
        agentId: "agent_test",
        status: "ready",
      });
      expect(JSON.parse(agentSourceChecks.stdout)).toMatchObject({
        workItem: { id: "work_item_test" },
        activity: { id: "activity_checks" },
      });
      const sourceChecksRequest = requests.find(
        (request) =>
          request.url === "/v1/agents/agent_test/source/checks?teamId=team_test" &&
          request.method === "POST" &&
          request.body.sourceRef === "master"
      );
      expect(sourceChecksRequest?.body).toMatchObject({
        checkKind: "validate",
        dispatch: "coding_core",
        metadata: { reason: "phase3" },
      });
      expect(
        JSON.parse(agentSourceSnapshots.stdout).manifestSnapshots[0]
      ).toMatchObject({
        id: "snapshot_test",
        manifestHash: "hash_test",
      });
      expect(JSON.parse(agentSourcePublish.stdout)).toMatchObject({
        activeManifestSnapshot: { id: "snapshot_test" },
        publishedAt: "2026-05-20T00:00:00.000Z",
      });
      expect(JSON.parse(agentEditOpen.stdout)).toMatchObject({
        workItem: { id: "work_item_test", projectId: "project_test" },
        created: true,
      });
      expect(JSON.parse(agentEditChat.stdout)).toMatchObject({
        userMessage: { id: "message_user" },
        assistantMessage: { id: "message_assistant" },
      });
      expect(JSON.parse(agentEditActivity.stdout).activity[0]).toMatchObject({
        id: "activity_checks",
        payload: {
          traceArtifactRef: "artifacts/openpond-trace.jsonl",
          evalResultArtifactRef: "artifacts/openpond-eval-results.json",
        },
      });
      expect(JSON.parse(agentEditBackground.stdout)).toMatchObject({
        activity: { id: "activity_background" },
      });
      expect(JSON.parse(agentEditRequestChecks.stdout)).toMatchObject({
        workItem: { id: "work_item_test" },
        activity: { id: "activity_checks" },
      });
      expect(
        JSON.parse(agentSourceCheckStatus.stdout).sourceCheckStatus
      ).toMatchObject({
        workItemId: "work_item_test",
        latestTaskRunId: "task_run_test",
        latestRuntimeId: "runtime_test",
        latestSandboxId: "sandbox_test",
        sourceMaterialization: {
          status: "completed",
          sourceCommitSha: "source_sha_test",
        },
        sourceUploadMetadata: {
          sourceTreeMode: "typescript_agent_sdk",
          commands: {
            inspect: "bun run agent:inspect",
            build: "bun run agent:build",
            validate: "bun run agent:validate",
            eval: "bun run agent:eval",
          },
          generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
          synthesizedOpenPondYaml: true,
          openPondYamlMode: "synthesized",
          uploadMetadataHash: {
            sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sizeBytes: 2816,
          },
          artifactHashes: {
            ".openpond/openpond-manifest.preview.yaml": {
              sha256:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            "openpond.yaml": {
              sha256:
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            },
          },
          dependencySetup: {
            required: true,
            installCommand: "bun install --offline",
            expectedBinaryPath: "node_modules/.bin/openpond-agent",
            sdkPackage: {
              path: ".openpond/vendor/openpond-agent-sdk.tgz",
            },
            dependencyPackages: [
              {
                packageName: "yaml",
                path: ".openpond/vendor/npm/yaml.tgz",
              },
              {
                packageName: "zod",
                path: ".openpond/vendor/npm/zod.tgz",
              },
            ],
          },
          redactedSetupOutputRefs: [
            "openpond://coding-task-runs/task_run_test/setup-output",
          ],
        },
        setup: {
          status: "completed",
          passed: true,
          commands: ["bun install --offline"],
          expectedBinaryPath: "node_modules/.bin/openpond-agent",
        },
        policyDiscovery: {
          status: "completed",
          command: "openpond agent inspect --json",
          requiredChecks: ["openpond agent validate", "openpond agent eval"],
        },
        discoveredRequiredChecks: [
          "openpond agent validate",
          "openpond agent eval",
        ],
        checkRuns: [
          {
            command: "openpond agent validate",
            status: "passed",
            passed: true,
          },
        ],
        validation: { status: "passed", passed: true },
        requestedCheckKind: "validate",
        deployPlan: {
          status: "needs_validation",
          canDeploy: false,
          blockedReasons: ["source_commit_sha_missing"],
        },
        traceArtifactRefs: ["artifacts/openpond-trace.jsonl"],
        evalResultArtifactRefs: ["artifacts/openpond-eval-results.json"],
        validatorArtifactRefs: ["artifacts/validator-report.json"],
        patchArtifactRef: "openpond://coding-task-runs/task_run_test/patch",
        finalResultState: "completed",
        publishBlockers: ["source_commit_sha_missing"],
      });
      expect(agentSourceCheckStatus.stdout).not.toContain("raw setup output");
      expect(agentSourceCheckStatus.stdout).not.toContain("super_secret_value");
      expect(
        JSON.parse(agentEditCheckStatus.stdout).sourceCheckStatus
          .sourceUploadMetadata
      ).toMatchObject({
        sourceTreeMode: "typescript_agent_sdk",
        openPondYamlMode: "synthesized",
        dependencySetup: {
          sdkPackage: {
            path: ".openpond/vendor/openpond-agent-sdk.tgz",
          },
        },
      });
      expect(agentEditCheckStatus.stdout).not.toContain("raw setup output");
      expect(agentEditCheckStatus.stdout).not.toContain("super_secret_value");
      expect(
        JSON.parse(agentEditFailedSetupStatus.stdout).sourceCheckStatus
      ).toMatchObject({
        workItemId: "work_item_failed_setup",
        workItemStatus: "failed",
        latestTaskRunId: "task_run_failed_setup",
        latestRuntimeId: "runtime_failed_setup",
        latestSandboxId: "sandbox_failed_setup",
        setup: {
          status: "failed",
          message: "yaml@^2.9.0 failed to resolve",
          command: "bun install --offline",
          exitCode: 1,
          commands: ["bun install --offline"],
          expectedBinaryPath: "node_modules/.bin/openpond-agent",
          dependencyPackages: [
            {
              packageName: "yaml",
              source: "npm",
              versionSpec: "^2.9.0",
              path: ".openpond/vendor/npm/yaml.tgz",
              sha256: "sha_yaml",
              sizeBytes: 112086,
            },
          ],
        },
      });
      expect(JSON.parse(agentEditCheckpointResult.stdout)).toMatchObject({
        artifact: { id: "artifact_checkpoint", kind: "checkpoint" },
      });
      expect(JSON.parse(agentEditCommitResult.stdout)).toMatchObject({
        artifact: { id: "artifact_commit", kind: "commit" },
      });
      expect(JSON.parse(agentEditPrResult.stdout)).toMatchObject({
        artifact: { id: "artifact_pr", kind: "pr" },
      });
      expect(requests.map((request) => request.url)).toEqual([
        "/v1/projects?teamId=team_test",
        "/v1/projects",
        "/v1/projects/project_test?teamId=team_test",
        "/v1/agents",
        "/v1/agents/agent_test?teamId=team_test",
        "/v1/agents/agent_test/run",
        "/v1/agents/agent_test?teamId=team_test",
        "/v1/agents/agent_test/source/deploy-plan?teamId=team_test",
        "/v1/agents/agent_test/source/checks?teamId=team_test",
        "/v1/agents/agent_test/source/manifest-snapshots?teamId=team_test&limit=2",
        "/v1/agents/agent_test/source/publish?teamId=team_test",
        "/v1/agents/agent_test/edit-work-item?teamId=team_test",
        "/v1/work-items/work_item_test/chat",
        "/v1/work-items/work_item_test/activity?teamId=team_test&limit=2",
        "/v1/work-items/work_item_test/handle-background",
        "/v1/agents/agent_test/source/checks?teamId=team_test",
        "/v1/work-items/work_item_test/status?teamId=team_test&limit=2&includeArchived=true",
        "/v1/work-items/work_item_test/status?teamId=team_test&limit=2&includeArchived=true",
        "/v1/work-items/work_item_failed_setup/status?teamId=team_test&limit=2&includeArchived=true",
        "/v1/work-items/work_item_test/result/checkpoint",
        "/v1/work-items/work_item_test/result/commit",
        "/v1/work-items/work_item_test/result/pr",
      ]);
      expect(requests[1]?.body).toMatchObject({
        teamId: "team_test",
        name: "Demo Project",
        sourceType: "internal_repo",
        gitOwner: "openpond",
        gitRepo: "demo-project",
      });
      expect(requests[2]?.body).toMatchObject({
        description: "Updated Project",
      });
      expect(requests[3]?.body).toMatchObject({
        teamId: "team_test",
        projectId: "project_test",
        selectedEntrypoint: { scope: "action", name: "hello" },
      });
      expect(requests[4]?.body).toMatchObject({
        triggerType: "background",
      });
      expect(requests[5]?.body).toMatchObject({
        teamId: "team_test",
        idempotencyKey: "run_key",
        conversationId: "session_run_1",
        targetProjectId: "target_project_test",
        targetProject: { id: "target_project_test" },
        input: { message: "hello" },
      });
      expect(requests[6]?.body).toMatchObject({
        runtimeSource: {
          mode: "published_snapshot",
          publishedSnapshotId: "snapshot_test",
        },
      });
      expect(requests[8]?.body).toMatchObject({
        checkKind: "validate",
        sourceRef: "master",
        metadata: { reason: "phase3" },
      });
      expect(requests[10]?.body).toMatchObject({
        expectedManifestHash: "hash_test",
        workItemId: "work_item_test",
        evalStatus: "passed",
      });
      expect(requests[11]?.body).toMatchObject({
        projectId: "project_test",
        initialMessage: "Update the agent",
        sourceRef: "draft/ref",
        baseSha: "base_sha_test",
        createPipelineRequest: {
          operation: "edit",
          surface: "hosted_edit",
          command: "/edit",
          objective: "Update the agent",
          adapter: {
            kind: "hosted",
            sourceAuthority: "hosted_profile",
            teamId: "team_test",
            projectId: "project_test",
            sourceRef: "draft/ref",
            baseSha: "base_sha_test",
          },
          targetAgent: {
            agentId: "agent_test",
            defaultActionKey: "agent_test.chat",
          },
        },
      });
      expect(requests[12]?.body).toMatchObject({
        teamId: "team_test",
        message: "Please update copy",
        mode: "queue_cloud",
        payload: { mode: "builder" },
      });
      expect(requests[14]?.body).toMatchObject({
        teamId: "team_test",
        prompt: "Run checks",
        agentEdit: {
          policyDiscovery: {
            command: "openpond agent inspect --json",
            runAfter: "source-materialized",
          },
          requiredChecks: ["openpond agent validate"],
        },
      });
      expect(requests[15]?.body).toMatchObject({
        checkKind: "eval",
        sourceRef: "draft/ref",
      });
      expect(requests[19]?.body).toMatchObject({
        teamId: "team_test",
        ref: "source_ref_test",
        metadata: { sourceHash: "hash_test" },
      });
      expect(requests[20]?.body).toMatchObject({
        teamId: "team_test",
        ref: "commit_ref_test",
      });
      expect(requests[21]?.body).toMatchObject({
        teamId: "team_test",
        ref: "pr_ref_test",
      });
    });
  }, 15_000);

  test("agent help separates local runs, remote runs, and source edits", async () => {
    const result = await runCli(["help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "openpond agent run <action> [--cwd <project>]"
    );
    expect(result.stdout).toContain(
      "openpond agent run <agentId> --team-id <id>"
    );
    expect(result.stdout).toContain("openpond agent source check-status");
    expect(result.stdout).toContain("openpond agent edit open <agentId>");
    expect(result.stdout).toContain(
      "openpond agent edit checkpoint-result|commit-result|pr-result"
    );
  });

  test("agent run-test sends target project binding", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const result = await runCli([
        "agent",
        "run-test",
        "agent_test",
        "--team-id",
        "team_test",
        "--target-project-id",
        "target_project_test",
        "--input",
        '{"prompt":"read workspace sentinel"}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(result.code).toBe(0);
      const runRequest = requests.find(
        (request) =>
          request.method === "POST" &&
          request.url === "/v1/agents/agent_test/run"
      );
      expect(runRequest?.body).toMatchObject({
        teamId: "team_test",
        targetProjectId: "target_project_test",
        targetProject: { id: "target_project_test" },
        input: { prompt: "read workspace sentinel" },
        metadata: { source: "agent_run_test" },
        runtimeSourcePolicy: {
          source: "diagnostic",
          allowLatestSource: true,
        },
      });
    });
  });

  test("agent edit check-status classifies setup, policy, validation, eval, and publish failures", async () => {
    const cases = [
      {
        workItemId: "work_item_dependency_install_failure",
        expected: {
          sourceUploadMetadata: {
            sourceTreeMode: "typescript_agent_sdk",
            openPondYamlMode: "synthesized",
            dependencySetup: {
              sdkPackage: {
                path: ".openpond/vendor/openpond-agent-sdk.tgz",
              },
            },
          },
          setup: {
            status: "failed",
            command: "bun install --offline",
            exitCode: 1,
            message: "dependency install failed",
          },
        },
      },
      {
        workItemId: "work_item_missing_sdk_binary",
        expected: {
          policyDiscovery: {
            status: "failed",
            command: "bun run agent:inspect",
            exitCode: 127,
            message: "missing node_modules/.bin/openpond-agent",
          },
        },
      },
      {
        workItemId: "work_item_unresolved_file_dependency",
        expected: {
          setup: {
            status: "failed",
            command: "bun install --offline",
            exitCode: 1,
            message: "unresolved local file dependency",
          },
        },
      },
      {
        workItemId: "work_item_missing_artifact_directory",
        expected: {
          policyDiscovery: {
            status: "failed",
            command: "bun run agent:inspect",
            exitCode: 1,
            message: "missing generated artifact directory .openpond",
          },
        },
      },
      {
        workItemId: "work_item_missing_source_upload_metadata",
        expected: {
          sourceMaterialization: {
            status: "blocked",
            message: "missing .openpond/source-upload-metadata.json",
            blockedReason: "source_upload_metadata_missing",
          },
          policyDiscovery: {
            status: "blocked",
            message: "source-upload metadata missing",
          },
          publishBlockers: ["source_upload_metadata_missing"],
        },
        notContains: ["openpond-agent inspect --json"],
      },
      {
        workItemId: "work_item_stale_source_upload_metadata",
        expected: {
          sourceUploadMetadata: {
            status: "stale",
            staleReasons: ["artifact_hash_mismatch"],
            sourceTreeMode: "typescript_agent_sdk",
            openPondYamlMode: "synthesized",
          },
          policyDiscovery: {
            status: "blocked",
            message: "source-upload metadata is stale",
          },
          publishBlockers: ["source_upload_metadata_stale"],
        },
        notContains: ["openpond-agent inspect --json"],
      },
      {
        workItemId: "work_item_invalid_inspect_json",
        expected: {
          policyDiscovery: {
            status: "failed",
            command: "bun run agent:inspect",
            exitCode: 1,
            message: "invalid inspect JSON",
          },
        },
      },
      {
        workItemId: "work_item_validation_failure",
        expected: {
          validation: {
            status: "failed",
            passed: false,
          },
          checkRuns: [
            {
              command: "bun run agent:validate",
              status: "failed",
              passed: false,
              exitCode: 1,
            },
          ],
          validatorArtifactRefs: ["artifacts/validator-report.json"],
        },
      },
      {
        workItemId: "work_item_eval_failure",
        expected: {
          eval: {
            status: "failed",
            passed: false,
          },
          checkRuns: [
            {
              command: "bun run agent:eval",
              status: "failed",
              passed: false,
              exitCode: 1,
            },
          ],
          evalResultArtifactRefs: ["artifacts/openpond-eval-results.json"],
        },
      },
      {
        workItemId: "work_item_publish_blocked",
        expected: {
          deployPlan: {
            status: "blocked",
            canDeploy: false,
            blockedReasons: ["source_commit_sha_missing", "failed_checks"],
          },
          publishBlockers: ["source_commit_sha_missing", "failed_checks"],
        },
      },
    ];

    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      for (const testCase of cases) {
        const result = await runCli([
          "agent",
          "edit",
          "check-status",
          testCase.workItemId,
          "--team-id",
          "team_test",
          "--limit",
          "2",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]);

        if (result.code !== 0) {
          throw new Error(
            `${testCase.workItemId} check-status failed: ${[
              result.stdout.trim(),
              result.stderr.trim(),
            ]
              .filter(Boolean)
              .join("\n")}`
          );
        }
        expect(result.stdout).not.toContain("raw sandbox process output");
        expect(result.stdout).not.toContain("super_secret_value");
        for (const pattern of testCase.notContains ?? []) {
          expect(result.stdout).not.toContain(pattern);
        }
        expect(JSON.parse(result.stdout).sourceCheckStatus).toMatchObject({
          workItemId: testCase.workItemId,
          workItemStatus: "failed",
          latestTaskRunId: `${testCase.workItemId}_task`,
          latestRuntimeId: `${testCase.workItemId}_runtime`,
          latestSandboxId: `${testCase.workItemId}_sandbox`,
          ...testCase.expected,
        });
      }
    });
  });

  test("agent edit/source public outputs stay compact when API responses include large raw fields", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const commands = [
        await runCli([
          "agent",
          "edit",
          "background",
          "work_item_large",
          "--team-id",
          "team_test",
          "--prompt",
          "Run compact output check",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
        await runCli([
          "agent",
          "edit",
          "activity",
          "work_item_large",
          "--team-id",
          "team_test",
          "--limit",
          "2",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
        await runCli([
          "agent",
          "edit",
          "check-status",
          "work_item_large",
          "--team-id",
          "team_test",
          "--limit",
          "2",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
        await runCli([
          "agent",
          "source",
          "check-status",
          "work_item_large",
          "--team-id",
          "team_test",
          "--limit",
          "2",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
        await runCli([
          "agent",
          "edit",
          "checkpoint-result",
          "work_item_large",
          "--team-id",
          "team_test",
          "--ref",
          "source_ref_large",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
        await runCli([
          "agent",
          "edit",
          "commit-result",
          "work_item_large",
          "--team-id",
          "team_test",
          "--ref",
          "commit_ref_large",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
        await runCli([
          "agent",
          "edit",
          "pr-result",
          "work_item_large",
          "--team-id",
          "team_test",
          "--ref",
          "pr_ref_large",
          "--sandbox-api-url",
          sandboxApiUrl,
        ]),
      ];

      for (const result of commands) {
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(LARGE_RAW_MARKER);
        expect(result.stdout.length).toBeLessThan(12_000);
        expect(result.stderr).not.toContain(LARGE_RAW_MARKER);
      }

      expect(JSON.parse(commands[0]!.stdout)).toMatchObject({
        workItem: { id: "work_item_large", status: "running" },
        activity: { id: "activity_large_background" },
      });
      expect(JSON.parse(commands[1]!.stdout)).toMatchObject({
        activity: [
          {
            id: "activity_large",
            payload: {
              traceArtifactRef: "artifacts/trace-large.jsonl",
              evalResultArtifactRef: "artifacts/eval-large.json",
            },
          },
        ],
      });
      for (const command of [commands[2], commands[3]]) {
        expect(JSON.parse(command!.stdout).sourceCheckStatus).toMatchObject({
          workItemId: "work_item_large",
          latestTaskRunId: "task_run_large",
          latestRuntimeId: "runtime_large",
          latestSandboxId: "sandbox_large",
          policyDiscovery: {
            status: "completed",
            command: "openpond agent inspect --json",
          },
          traceArtifactRefs: ["artifacts/trace-large.jsonl"],
          evalResultArtifactRefs: ["artifacts/eval-large.json"],
        });
      }
      expect(JSON.parse(commands[4]!.stdout)).toMatchObject({
        artifact: { id: "artifact_large_checkpoint", ref: "source_ref_large" },
      });
      expect(JSON.parse(commands[5]!.stdout)).toMatchObject({
        artifact: { id: "artifact_large_commit", ref: "commit_ref_large" },
      });
      expect(JSON.parse(commands[6]!.stdout)).toMatchObject({
        artifact: { id: "artifact_large_pr", ref: "pr_ref_large" },
      });
    });
  });

  test("profile push uploads selected nested SDK agent dependencies", async () => {
    const repoPath = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-sdk-upload-")
    );
    try {
      const sourcePath = path.join(repoPath, "profiles", "default");
      const agentRoot = path.join(sourcePath, "agents", "invoice-agent");
      await mkdir(sourcePath, { recursive: true });
      await writeAgentSdkUploadFixture(agentRoot);
      await writeFile(
        path.join(repoPath, "openpond-profile.json"),
        JSON.stringify(
          {
            schema: "openpond.profileRepo.v1",
            defaultProfile: "default",
            profiles: {
              default: {
                path: "profiles/default",
                defaultAgent: "invoice-agent",
                enabledAgents: ["invoice-agent"],
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );
      await runTestCommand("git", ["init", "-b", "main"], repoPath);
      await runTestCommand("git", ["add", "-A"], repoPath);

      const upload = await collectProfileSourceUploadForPush({
        state: {
          repoPath,
          sourcePath,
          agents: [
            {
              id: "invoice-agent",
              name: "Invoice Agent",
              enabled: true,
              path: "agents/invoice-agent",
            },
          ],
        } as Parameters<typeof collectProfileSourceUploadForPush>[0]["state"],
        hostedSourceAgentId: "invoice-agent",
      });
      const paths = upload.entries.map((entry) => entry.path).sort();
      expect(paths).toContain(
        "profiles/default/agents/invoice-agent/package.json"
      );
      expect(paths).toContain(
        "profiles/default/agents/invoice-agent/.openpond/source-upload-metadata.json"
      );
      expect(paths).toContain(
        "profiles/default/agents/invoice-agent/.openpond/vendor/openpond-agent-sdk.tgz"
      );
      expect(paths).toContain(
        "profiles/default/agents/invoice-agent/.openpond/vendor/npm/fixture-runtime-dep.tgz"
      );

      const uploadedPackageJson = upload.entries.find(
        (entry) =>
          entry.path === "profiles/default/agents/invoice-agent/package.json"
      );
      const uploadedPackage = JSON.parse(
        Buffer.from(
          uploadedPackageJson?.contentsBase64 ?? "",
          "base64"
        ).toString("utf8")
      ) as {
        dependencies?: Record<string, string>;
        overrides?: Record<string, string>;
      };
      expect(uploadedPackage.dependencies?.["openpond-agent-sdk"]).toBe(
        "file:.openpond/vendor/openpond-agent-sdk.tgz"
      );
      expect(uploadedPackage.dependencies?.["fixture-runtime-dep"]).toBe(
        "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
      );
      expect(uploadedPackage.overrides?.["fixture-runtime-dep"]).toBe(
        "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
      );

      const materializedDir = await mkdtemp(
        path.join(os.tmpdir(), "openpond-profile-sdk-materialized-")
      );
      try {
        await writeSourceUploadEntriesToDirectory(upload.entries, materializedDir);
        const materializedAgentRoot = path.join(
          materializedDir,
          "profiles",
          "default",
          "agents",
          "invoice-agent"
        );
        await runDependencySetupFromUploadMetadata(materializedAgentRoot);
        const inspectResult = await runTestCommandWithOutput(
          "bun",
          ["run", "agent:inspect"],
          materializedAgentRoot
        );
        expect(JSON.parse(inspectResult.stdout)).toMatchObject({
          editable: { enabled: true },
        });
      } finally {
        await rm(materializedDir, { recursive: true, force: true });
      }
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  test("project source-upload builds SDK agents and uploads generated manifest artifacts", async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-agent-sdk-upload-")
    );
    try {
      await writeAgentSdkUploadFixture(projectDir);
      await runTestCommand("git", ["init"], projectDir);

      const requests: CapturedRequest[] = [];
      await withSandboxApi(requests, async (sandboxApiUrl) => {
        const result = await runCli([
          "project",
          "source-upload",
          "project_test",
          "--team-id",
          "team_test",
          "--path",
          projectDir,
          "--sandbox-api-url",
          sandboxApiUrl,
        ]);

        expect(result.code).toBe(0);
        const body = requests[0]?.body as {
          entries?: Array<{ path: string; contentsBase64?: string }>;
        };
        const paths = (body.entries ?? []).map((entry) => entry.path).sort();
        expect(paths).toContain("agent/agent.ts");
        expect(paths).toContain("package.json");
        expect(paths).toContain("openpond.yaml");
        expect(paths).toContain(".openpond/agent-inspect.json");
        expect(paths).toContain(".openpond/agent-manifest.json");
        expect(paths).toContain(".openpond/action-registry.json");
        expect(paths).toContain(".openpond/openpond-manifest.preview.yaml");
        expect(paths).toContain(".openpond/runtime-bridge.mjs");
        expect(paths).toContain(".openpond/validator-report.md");
        expect(paths).toContain(".openpond/source-upload-metadata.json");
        expect(paths).toContain(".openpond/vendor/openpond-agent-sdk.tgz");
        expect(paths).toContain(".openpond/vendor/npm/fixture-runtime-dep.tgz");
        expect(paths).not.toContain(".openpond/eval-results.json");
        expect(paths).not.toContain(".openpond/local-sdk-source/package.json");
        expect(paths.some((entryPath) => entryPath.startsWith("node_modules/"))).toBe(false);

        const uploadedPackageJson = body.entries?.find(
          (entry) => entry.path === "package.json"
        );
        expect(uploadedPackageJson?.contentsBase64).toBeTruthy();
        const uploadedPackage = JSON.parse(
          Buffer.from(
            uploadedPackageJson?.contentsBase64 ?? "",
            "base64"
          ).toString("utf8")
        ) as {
          dependencies?: Record<string, string>;
          overrides?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        expect(uploadedPackage.dependencies?.["openpond-agent-sdk"]).toBe(
          "file:.openpond/vendor/openpond-agent-sdk.tgz"
        );
        expect(uploadedPackage.dependencies?.["fixture-runtime-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
        );
        expect(uploadedPackage.overrides?.["fixture-runtime-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
        );
        expect(uploadedPackage.devDependencies?.["openpond-agent-sdk"]).toBeUndefined();
        expect(uploadedPackage.peerDependencies?.["openpond-agent-sdk"]).toBeUndefined();

        const openPondYaml = body.entries?.find(
          (entry) => entry.path === "openpond.yaml"
        );
        expect(openPondYaml?.contentsBase64).toBeTruthy();
        const openPondYamlSource = Buffer.from(
          openPondYaml?.contentsBase64 ?? "",
          "base64"
        ).toString("utf8");
        expect(openPondYamlSource).toContain("schemaVersion: 1");
        expect(openPondYamlSource).toContain("setup:\n  commands:\n    - bun install --offline");
        expect(openPondYamlSource).not.toContain(
          "schema: openpond.runtime.manifest.v1"
        );
        const uploadMetadata = body.entries?.find(
          (entry) => entry.path === ".openpond/source-upload-metadata.json"
        );
        expect(uploadMetadata?.contentsBase64).toBeTruthy();
        const uploadMetadataSource = Buffer.from(
          uploadMetadata?.contentsBase64 ?? "",
          "base64"
        ).toString("utf8");
        const uploadMetadataJson = JSON.parse(
          uploadMetadataSource
        ) as {
          schema?: string;
          sourceTreeMode?: string;
          packageManager?: string;
          sdk?: { packageName?: string; versionSpec?: string };
          commands?: Record<string, string>;
          dependencySetup?: {
            required?: boolean;
            packageManager?: string;
            installCommand?: string;
            commands?: string[];
            expectedBinaryPath?: string;
            generatedArtifactDirectory?: string;
            sdkPackage?: {
              source?: string;
              path?: string;
              sha256?: string;
              sizeBytes?: number;
            };
            dependencyPackages?: Array<{
              packageName?: string;
              source?: string;
              versionSpec?: string;
              path?: string;
              sha256?: string;
              sizeBytes?: number;
            }>;
          };
          setupRequirements?: Array<Record<string, unknown>>;
          generatedManifestPath?: string;
          synthesizedOpenPondYaml?: boolean;
          artifactHashes?: Record<string, { sha256?: string; sizeBytes?: number }>;
        };
        expect(uploadMetadataJson).toMatchObject({
          schema: "openpond.agent.source_upload.v1",
          sourceTreeMode: "typescript_agent_sdk",
          packageManager: "unknown",
          sdk: {
            packageName: "openpond-agent-sdk",
            versionSpec: "file:.openpond/local-sdk-source",
          },
          commands: {
            inspect: "bun run agent:inspect",
            build: "bun run agent:build",
            validate: "bun run agent:validate",
            eval: "bun run agent:eval",
          },
          generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
          synthesizedOpenPondYaml: true,
          dependencySetup: {
            required: true,
            packageManager: "unknown",
            installCommand: "bun install --offline",
            commands: ["bun install --offline"],
            expectedBinaryPath: "node_modules/.bin/openpond-agent",
            generatedArtifactDirectory: ".openpond",
            sdkPackage: {
              source: "uploaded_tarball",
              path: ".openpond/vendor/openpond-agent-sdk.tgz",
            },
            dependencyPackages: [
              {
                packageName: "fixture-runtime-dep",
                source: "npm_dependency_tarball",
                versionSpec: "file:../fixture-runtime-dep",
                path: ".openpond/vendor/npm/fixture-runtime-dep.tgz",
              },
            ],
          },
          setupRequirements: [
            {
              actionId: "chat",
              kind: "env",
              name: "UPLOAD_FIXTURE_TOKEN",
              required: true,
              secret: true,
              status: "setup_required",
            },
          ],
        });
        expect(
          uploadMetadataJson.dependencySetup?.sdkPackage?.sha256
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(
          uploadMetadataJson.dependencySetup?.sdkPackage?.sizeBytes
        ).toBeGreaterThan(0);
        expect(
          uploadMetadataJson.dependencySetup?.dependencyPackages?.[0]?.sha256
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(
          uploadMetadataJson.dependencySetup?.dependencyPackages?.[0]?.sizeBytes
        ).toBeGreaterThan(0);
        expect(
          uploadMetadataJson.artifactHashes?.[
            ".openpond/openpond-manifest.preview.yaml"
          ]?.sha256
        ).toMatch(/^[a-f0-9]{64}$/);
        expect(uploadMetadataJson.artifactHashes?.["openpond.yaml"]?.sha256).toMatch(
          /^[a-f0-9]{64}$/
        );

        const output = JSON.parse(result.stdout) as {
          uploaded?: {
            agentSdk?: {
              generatedManifestPath?: string;
              synthesizedOpenPondYaml?: boolean;
              uploadMetadataPath?: string;
              commands?: Record<string, string>;
              dependencySetup?: Record<string, unknown>;
              packageManager?: string;
              sourceTreeMode?: string;
              uploadMetadataHash?: { sha256?: string; sizeBytes?: number };
              artifactHashes?: Record<string, { sha256?: string }>;
            };
          };
        };
        expect(output.uploaded?.agentSdk).toMatchObject({
          generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
          synthesizedOpenPondYaml: true,
          uploadMetadataPath: ".openpond/source-upload-metadata.json",
          packageManager: "unknown",
          sourceTreeMode: "typescript_agent_sdk",
          commands: {
            inspect: "bun run agent:inspect",
            build: "bun run agent:build",
            validate: "bun run agent:validate",
            eval: "bun run agent:eval",
          },
          dependencySetup: {
            required: true,
            installCommand: "bun install --offline",
          },
        });
        expect(output.uploaded?.agentSdk?.uploadMetadataHash).toEqual({
          sha256: createHash("sha256").update(uploadMetadataSource).digest("hex"),
          sizeBytes: Buffer.byteLength(uploadMetadataSource, "utf8"),
        });
        expect(
          output.uploaded?.agentSdk?.artifactHashes?.["openpond.yaml"]?.sha256
        ).toMatch(/^[a-f0-9]{64}$/);

        const materializedDir = await mkdtemp(
          path.join(os.tmpdir(), "openpond-agent-sdk-materialized-")
        );
        try {
          await writeSourceUploadEntriesToDirectory(
            body.entries ?? [],
            materializedDir
          );
          await runDependencySetupFromUploadMetadata(materializedDir);

          const inspectResult = await runTestCommandWithOutput(
            "bun",
            ["run", "agent:inspect"],
            materializedDir
          );
          expect(JSON.parse(inspectResult.stdout)).toMatchObject({
            editable: { enabled: true },
          });

          await runTestCommand("bun", ["run", "agent:validate"], materializedDir);
          await runTestCommand("bun", ["run", "agent:eval"], materializedDir);

          const materializedEval = await readFile(
            path.join(materializedDir, ".openpond", "eval-results.json"),
            "utf8"
          );
          expect(JSON.parse(materializedEval)).toMatchObject({ ok: true });
        } finally {
          await rm(materializedDir, { recursive: true, force: true });
        }
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("project source-upload supports SDK agent folders without git metadata", async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-agent-sdk-nongit-upload-")
    );
    try {
      await writeAgentSdkUploadFixture(projectDir);

      const requests: CapturedRequest[] = [];
      await withSandboxApi(requests, async (sandboxApiUrl) => {
        const result = await runCli([
          "project",
          "source-upload",
          "project_test",
          "--team-id",
          "team_test",
          "--path",
          projectDir,
          "--sandbox-api-url",
          sandboxApiUrl,
        ]);

        expect(result.code).toBe(0);
        const body = requests[0]?.body as {
          entries?: Array<{ path: string; contentsBase64?: string }>;
        };
        const paths = (body.entries ?? []).map((entry) => entry.path).sort();
        expect(paths).toContain("agent/agent.ts");
        expect(paths).toContain("package.json");
        expect(paths).toContain("openpond.yaml");
        expect(paths).toContain(".openpond/agent-inspect.json");
        expect(paths).toContain(".openpond/agent-manifest.json");
        expect(paths).toContain(".openpond/action-registry.json");
        expect(paths).toContain(".openpond/openpond-manifest.preview.yaml");
        expect(paths).toContain(".openpond/runtime-bridge.mjs");
        expect(paths).toContain(".openpond/validator-report.md");
        expect(paths).toContain(".openpond/source-upload-metadata.json");
        expect(paths).not.toContain(".openpond/eval-results.json");
        expect(paths.some((entryPath) => entryPath.startsWith(".git/"))).toBe(
          false
        );
        expect(paths.some((entryPath) => entryPath.startsWith("node_modules/"))).toBe(false);

        const uploadedPackageJson = body.entries?.find(
          (entry) => entry.path === "package.json"
        );
        expect(uploadedPackageJson?.contentsBase64).toBeTruthy();
        const uploadedPackageSource = Buffer.from(
          uploadedPackageJson?.contentsBase64 ?? "",
          "base64"
        ).toString("utf8");
        expect(uploadedPackageSource).not.toContain(projectDir);
        expect(uploadedPackageSource).not.toContain("file:../");
        expect(uploadedPackageSource).not.toContain(
          ".openpond/local-sdk-source"
        );
        const uploadedPackage = JSON.parse(uploadedPackageSource) as {
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          overrides?: Record<string, string>;
        };
        expect(uploadedPackage.scripts).toMatchObject({
          "agent:inspect": "openpond-agent inspect --json",
          "agent:validate": "openpond-agent validate",
          "agent:eval": "openpond-agent eval",
        });
        expect(uploadedPackage.dependencies?.["openpond-agent-sdk"]).toBe(
          "file:.openpond/vendor/openpond-agent-sdk.tgz"
        );
        expect(uploadedPackage.dependencies?.["fixture-runtime-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
        );
        expect(uploadedPackage.overrides?.["fixture-runtime-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
        );

        const uploadMetadata = body.entries?.find(
          (entry) => entry.path === ".openpond/source-upload-metadata.json"
        );
        expect(uploadMetadata?.contentsBase64).toBeTruthy();
        const uploadMetadataSource = Buffer.from(
          uploadMetadata?.contentsBase64 ?? "",
          "base64"
        ).toString("utf8");
        expect(uploadMetadataSource).not.toContain(projectDir);
        const uploadMetadataJson = JSON.parse(uploadMetadataSource) as {
          dependencySetup?: {
            sdkPackage?: { path?: string };
            dependencyPackages?: Array<{ path?: string }>;
          };
        };
        expect(uploadMetadataJson.dependencySetup?.sdkPackage?.path).toBe(
          ".openpond/vendor/openpond-agent-sdk.tgz"
        );
        expect(
          uploadMetadataJson.dependencySetup?.dependencyPackages?.[0]?.path
        ).toBe(".openpond/vendor/npm/fixture-runtime-dep.tgz");

        const materializedDir = await mkdtemp(
          path.join(os.tmpdir(), "openpond-agent-sdk-nongit-materialized-")
        );
        try {
          await writeSourceUploadEntriesToDirectory(
            body.entries ?? [],
            materializedDir
          );
          await runDependencySetupFromUploadMetadata(materializedDir);

          const inspectResult = await runTestCommandWithOutput(
            "bun",
            ["run", "agent:inspect"],
            materializedDir
          );
          expect(JSON.parse(inspectResult.stdout)).toMatchObject({
            editable: { enabled: true },
          });

          await runTestCommand("bun", ["run", "agent:validate"], materializedDir);
          await runTestCommand("bun", ["run", "agent:eval"], materializedDir);

          const materializedEval = await readFile(
            path.join(materializedDir, ".openpond", "eval-results.json"),
            "utf8"
          );
          expect(JSON.parse(materializedEval)).toMatchObject({ ok: true });
        } finally {
          await rm(materializedDir, { recursive: true, force: true });
        }
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("project source-upload materializes pilots copied from a packed SDK install", async () => {
    const sdkRoot = resolveTestAgentSdkRoot();
    const workRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-agent-sdk-packed-upload-")
    );
    try {
      const packDir = path.join(workRoot, "pack");
      await mkdir(packDir, { recursive: true });
      await runTestCommand("bun", ["run", "build"], sdkRoot);
      const packResult = await runTestCommandWithOutput(
        "npm",
        ["pack", "--silent", "--pack-destination", packDir],
        sdkRoot
      );
      const tarballName = packResult.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .pop();
      expect(tarballName).toBeTruthy();
      const sdkTarballPath = path.join(packDir, tarballName ?? "");

      const requests: CapturedRequest[] = [];
      await withSandboxApi(requests, async (sandboxApiUrl) => {
        for (const pilotName of AGENT_SDK_PILOT_NAMES) {
          const projectDir = path.join(workRoot, "pilots", pilotName);
          await cp(path.join(sdkRoot, "examples", pilotName), projectDir, {
            recursive: true,
          });
          await rm(path.join(projectDir, ".openpond"), {
            recursive: true,
            force: true,
          });
          await rm(path.join(projectDir, "node_modules"), {
            recursive: true,
            force: true,
          });
          await rewriteAgentSdkDependencyForTest(
            projectDir,
            `file:${path.relative(projectDir, sdkTarballPath)}`
          );
          await runTestCommand("bun", ["install"], projectDir);

          requests.length = 0;
          const result = await runCli([
            "project",
            "source-upload",
            "project_test",
            "--team-id",
            "team_test",
            "--path",
            projectDir,
            "--sandbox-api-url",
            sandboxApiUrl,
          ]);

          expect(result.code).toBe(0);
          const body = requests[0]?.body as {
            entries?: Array<{ path: string; contentsBase64?: string }>;
          };
          const paths = (body.entries ?? [])
            .map((entry) => entry.path)
            .sort();
          expect(paths).toContain("agent/agent.ts");
          expect(paths).toContain("package.json");
          expect(paths).toContain("openpond.yaml");
          expect(paths).toContain(".openpond/source-upload-metadata.json");
          expect(paths).toContain(".openpond/vendor/openpond-agent-sdk.tgz");
          expect(paths).toContain(".openpond/vendor/npm/yaml.tgz");
          expect(paths).toContain(".openpond/vendor/npm/zod.tgz");
          expect(
            paths.some((entryPath) => entryPath.startsWith("node_modules/"))
          ).toBe(false);

          const uploadedPackageJson = body.entries?.find(
            (entry) => entry.path === "package.json"
          );
          expect(uploadedPackageJson?.contentsBase64).toBeTruthy();
          const uploadedPackage = JSON.parse(
            Buffer.from(
              uploadedPackageJson?.contentsBase64 ?? "",
              "base64"
            ).toString("utf8")
          ) as {
            dependencies?: Record<string, string>;
            overrides?: Record<string, string>;
          };
          expect(uploadedPackage.dependencies?.["openpond-agent-sdk"]).toBe(
            "file:.openpond/vendor/openpond-agent-sdk.tgz"
          );
          expect(uploadedPackage.dependencies?.yaml).toBe(
            "file:.openpond/vendor/npm/yaml.tgz"
          );
          expect(uploadedPackage.dependencies?.zod).toBe(
            "file:.openpond/vendor/npm/zod.tgz"
          );
          expect(uploadedPackage.overrides?.yaml).toBe(
            "file:.openpond/vendor/npm/yaml.tgz"
          );
          expect(uploadedPackage.overrides?.zod).toBe(
            "file:.openpond/vendor/npm/zod.tgz"
          );

          const output = JSON.parse(result.stdout) as {
            uploaded?: {
              agentSdk?: {
                sourceTreeMode?: string;
                synthesizedOpenPondYaml?: boolean;
                uploadMetadataHash?: { sha256?: string };
              };
            };
          };
          expect(output.uploaded?.agentSdk).toMatchObject({
            sourceTreeMode: "typescript_agent_sdk",
            synthesizedOpenPondYaml: true,
          });
          expect(output.uploaded?.agentSdk?.uploadMetadataHash?.sha256).toMatch(
            /^[a-f0-9]{64}$/
          );

          const materializedDir = await mkdtemp(
            path.join(
              os.tmpdir(),
              `openpond-agent-sdk-packed-${pilotName}-materialized-`
            )
          );
          try {
            await writeSourceUploadEntriesToDirectory(
              body.entries ?? [],
              materializedDir
            );
            await runDependencySetupFromUploadMetadata(materializedDir);
            const inspectResult = await runTestCommandWithOutput(
              "bun",
              ["run", "agent:inspect"],
              materializedDir
            );
            expect(JSON.parse(inspectResult.stdout)).toMatchObject({
              editable: { enabled: true },
            });
            await runTestCommand(
              "bun",
              ["run", "agent:validate"],
              materializedDir
            );
            await runTestCommand("bun", ["run", "agent:eval"], materializedDir);
          } finally {
            await rm(materializedDir, { recursive: true, force: true });
          }
        }
      });
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }, 120_000);

  test("sdk exposes project and agent handles without requiring app ids", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const client = createOpenPondSandboxClient({
        apiKey: "opk_test_cli",
        sandboxApiUrl,
      });

      const project = await client.projects.upsert({
        teamId: "team_test",
        name: "SDK Project",
        sourceType: "manual",
      });
      const projectAgain = await client.projects.upsert({
        teamId: "team_test",
        name: "SDK Project",
        sourceType: "manual",
      });
      const projectUpdated = await client.projects.update(project.id, {
        teamId: "team_test",
        description: "Updated SDK Project",
      });
      const agent = await client.agents.upsert({
        teamId: "team_test",
        projectId: project.id,
        name: "SDK Agent",
        selectedEntrypoint: { scope: "entire_manifest" },
      });
      const agentAgain = await client.agents.upsert({
        teamId: "team_test",
        projectId: project.id,
        name: "SDK Agent",
        selectedEntrypoint: { scope: "entire_manifest" },
      });
      const agentUpdated = await client.agents.update(agent.id, {
        teamId: "team_test",
        triggerType: "background",
      });
      const result = await client.agents.run(agent.id, {
        teamId: "team_test",
        idempotencyKey: "sdk_run",
      });

      expect(project).toMatchObject({
        id: "project_test",
        teamId: "team_test",
      });
      expect(projectAgain.id).toBe(project.id);
      expect(projectUpdated.description).toBe("Updated SDK Project");
      expect(agent).toMatchObject({
        id: "agent_test",
        projectId: "project_test",
      });
      expect(agentAgain.id).toBe(agent.id);
      expect(agentUpdated.triggerType).toBe("background");
      expect(result.run).toMatchObject({
        id: "agent_run_test",
        agentId: "agent_test",
      });
      expect(requests.map((request) => request.url)).toEqual([
        "/v1/projects",
        "/v1/projects",
        "/v1/projects/project_test?teamId=team_test",
        "/v1/agents",
        "/v1/agents",
        "/v1/agents/agent_test?teamId=team_test",
        "/v1/agents/agent_test/run",
      ]);
      expect(requests[0]?.body).not.toHaveProperty("appId");
      expect(requests[1]?.body).not.toHaveProperty("appId");
      expect(requests[2]?.body).toMatchObject({
        description: "Updated SDK Project",
      });
      expect(requests[2]?.body).not.toHaveProperty("appId");
      expect(requests[3]?.body).not.toHaveProperty("appId");
      expect(requests[4]?.body).not.toHaveProperty("appId");
      expect(requests[5]?.body).toMatchObject({ triggerType: "background" });
      expect(requests[5]?.body).not.toHaveProperty("appId");
    });
  });
});
