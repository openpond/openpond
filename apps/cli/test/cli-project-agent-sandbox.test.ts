import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createOpenPondSandboxClient } from "../src/sandbox/client";
import { collectProfileSourceUploadForPush } from "../src/cli/profile";
import {
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

describe("project and agent sandbox CLI scenarios", () => {
  test("project and agent commands use first-class sandbox API resources", async () => {
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
        '{"reason":"phase5"}',
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
        "--eval-status",
        "passed",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      for (const result of [
        projectList,
        projectCreate,
        projectUpdate,
        agentCreate,
        agentUpdate,
        agentRun,
        agentBindSource,
        agentSourceDeployPlan,
        agentSourceChecks,
        agentSourceSnapshots,
        agentSourcePublish,
      ]) {
        expect(result.code).toBe(0);
      }

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
      expect(JSON.parse(agentSourceDeployPlan.stdout).deployPlan).toMatchObject({
        agentId: "agent_test",
        status: "ready",
      });
      expect(JSON.parse(agentSourceChecks.stdout)).toMatchObject({
        sourceCheckStatus: {
          latestTaskRunId: "task_run_test",
          validation: { status: "passed", passed: true },
        },
        dispatchResult: {
          status: "completed",
          taskRun: { id: "task_run_test" },
        },
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

      expect(requests.map((request) => request.url)).toEqual([
        "/v1/projects?teamId=team_test",
        "/v1/projects?teamId=team_test",
        "/v1/projects/project_test?teamId=team_test",
        "/v1/agents?teamId=team_test",
        "/v1/agents/agent_test?teamId=team_test",
        "/v1/agents/agent_test/run?teamId=team_test",
        "/v1/agents/agent_test?teamId=team_test",
        "/v1/agents/agent_test/source/deploy-plan?teamId=team_test",
        "/v1/agents/agent_test/source/checks?teamId=team_test",
        "/v1/agents/agent_test/source/manifest-snapshots?teamId=team_test&limit=2",
        "/v1/agents/agent_test/source/publish?teamId=team_test",
      ]);
      expect(requests[8]?.body).toMatchObject({
        checkKind: "validate",
        sourceRef: "master",
        metadata: { reason: "phase5" },
      });
      expect(requests[10]?.body).toMatchObject({
        expectedManifestHash: "hash_test",
        evalStatus: "passed",
      });
    });
  }, 90_000);

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
          request.url === "/v1/agents/agent_test/run?teamId=team_test"
      );
      expect(runRequest?.body).toMatchObject({
        targetProjectId: "target_project_test",
        targetProject: { id: "target_project_test" },
        input: { prompt: "read workspace sentinel" },
        metadata: { source: "agent_run_test" },
        runtimeSourcePolicy: {
          source: "diagnostic",
          allowLatestSource: true,
        },
      });
      expect(runRequest?.body).not.toHaveProperty("teamId");
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
          "pnpm",
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
        expect(paths).toContain(".openpond/vendor/npm/fixture-project-dep.tgz");
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
          packageManager?: string;
        };
        expect(uploadedPackage.dependencies?.["openpond-agent-sdk"]).toBe(
          "file:.openpond/vendor/openpond-agent-sdk.tgz"
        );
        expect(uploadedPackage.dependencies?.["fixture-runtime-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
        );
        expect(uploadedPackage.dependencies?.["fixture-project-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-project-dep.tgz"
        );
        expect(uploadedPackage.overrides?.["fixture-project-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-project-dep.tgz"
        );
        expect(uploadedPackage.overrides?.["fixture-runtime-dep"]).toBe(
          "file:.openpond/vendor/npm/fixture-runtime-dep.tgz"
        );
        expect(uploadedPackage.devDependencies?.["openpond-agent-sdk"]).toBeUndefined();
        expect(uploadedPackage.peerDependencies?.["openpond-agent-sdk"]).toBeUndefined();
        expect(uploadedPackage.packageManager).toBeUndefined();

        const openPondYaml = body.entries?.find(
          (entry) => entry.path === "openpond.yaml"
        );
        expect(openPondYaml?.contentsBase64).toBeTruthy();
        const openPondYamlSource = Buffer.from(
          openPondYaml?.contentsBase64 ?? "",
          "base64"
        ).toString("utf8");
        expect(openPondYamlSource).toContain("schemaVersion: 1");
        expect(openPondYamlSource).toContain("setup:\n  commands:\n    - pnpm install --offline");
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
            inspect: "pnpm --silent run agent:inspect",
            build: "pnpm run agent:build",
            validate: "pnpm run agent:validate",
            eval: "pnpm run agent:eval",
          },
          generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
          synthesizedOpenPondYaml: true,
          dependencySetup: {
            required: true,
            packageManager: "unknown",
            installCommand: "pnpm install --offline",
            commands: ["pnpm install --offline"],
            expectedBinaryPath: "node_modules/.bin/openpond-agent",
            generatedArtifactDirectory: ".openpond",
            sdkPackage: {
              source: "uploaded_tarball",
              path: ".openpond/vendor/openpond-agent-sdk.tgz",
            },
            dependencyPackages: [
              {
                packageName: "fixture-project-dep",
                source: "npm_dependency_tarball",
                versionSpec: "file:.openpond/fixture-project-dep",
                path: ".openpond/vendor/npm/fixture-project-dep.tgz",
              },
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
            inspect: "pnpm --silent run agent:inspect",
            build: "pnpm run agent:build",
            validate: "pnpm run agent:validate",
            eval: "pnpm run agent:eval",
          },
          dependencySetup: {
            required: true,
            installCommand: "pnpm install --offline",
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
            "pnpm",
            ["run", "agent:inspect"],
            materializedDir
          );
          expect(JSON.parse(inspectResult.stdout)).toMatchObject({
            editable: { enabled: true },
          });

          await runTestCommand("pnpm", ["run", "agent:validate"], materializedDir);
          await runTestCommand("pnpm", ["run", "agent:eval"], materializedDir);

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
            dependencyPackages?: Array<{ packageName?: string; path?: string }>;
          };
        };
        expect(uploadMetadataJson.dependencySetup?.sdkPackage?.path).toBe(
          ".openpond/vendor/openpond-agent-sdk.tgz"
        );
        expect(
          uploadMetadataJson.dependencySetup?.dependencyPackages?.find(
            (dependency) => dependency.packageName === "fixture-runtime-dep"
          )?.path
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
            "pnpm",
            ["run", "agent:inspect"],
            materializedDir
          );
          expect(JSON.parse(inspectResult.stdout)).toMatchObject({
            editable: { enabled: true },
          });

          await runTestCommand("pnpm", ["run", "agent:validate"], materializedDir);
          await runTestCommand("pnpm", ["run", "agent:eval"], materializedDir);

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

  test("project source-upload materializes a dependency-rich pilot copied from a packed SDK install", async () => {
    const sdkRoot = resolveTestAgentSdkRoot();
    const workRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-agent-sdk-packed-upload-")
    );
    try {
      const packDir = path.join(workRoot, "pack");
      await mkdir(packDir, { recursive: true });
      await runTestCommand("pnpm", ["run", "build"], sdkRoot);
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
        for (const pilotName of ["integration-heavy-agent"] as const) {
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
          await runTestCommand("pnpm", ["install"], projectDir);

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

          expect(result.code, result.stderr || result.stdout).toBe(0);
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
              "pnpm",
              ["run", "agent:inspect"],
              materializedDir
            );
            expect(JSON.parse(inspectResult.stdout)).toMatchObject({
              editable: { enabled: true },
            });
            await runTestCommand(
              "pnpm",
              ["run", "agent:validate"],
              materializedDir
            );
            await runTestCommand("pnpm", ["run", "agent:eval"], materializedDir);
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
        "/v1/projects?teamId=team_test",
        "/v1/projects?teamId=team_test",
        "/v1/projects/project_test?teamId=team_test",
        "/v1/agents?teamId=team_test",
        "/v1/agents?teamId=team_test",
        "/v1/agents/agent_test?teamId=team_test",
        "/v1/agents/agent_test/run?teamId=team_test",
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
