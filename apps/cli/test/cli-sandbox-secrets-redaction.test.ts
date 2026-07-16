import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { CLI_SECRET, type CapturedRequest, runCli, withSandboxApi } from "./cli-sandbox-fixture";

describe("sandbox secret and create CLI redaction", () => {
  test("secret-create reads stdin and never echoes plaintext", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const result = await runCli(
        [
          "sandbox",
          "secret-create",
          "--name",
          "FOO_API_KEY",
          "--stdin",
          "--sandbox-api-url",
          sandboxApiUrl,
        ],
        `${CLI_SECRET}\n`
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "openpond://secret/team_test/secret_test#v1"
      );
      expect(result.stdout).not.toContain(CLI_SECRET);
      expect(result.stderr).not.toContain(CLI_SECRET);
      expect(requests[0]?.url).toBe("/v1/sandbox-secrets");
      expect(requests[0]?.body).toMatchObject({
        name: "FOO_API_KEY",
        value: CLI_SECRET,
      });
      expect(requests[0]?.apiKey).toBe("opk_test_cli");
    });
  });

  test("secret-create rejects argv values without echoing plaintext", async () => {
    const result = await runCli([
      "sandbox",
      "secret-create",
      "--name",
      "FOO_API_KEY",
      "--value",
      CLI_SECRET,
      "--sandbox-api-url",
      "http://127.0.0.1:9/v1/sandboxes",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain(CLI_SECRET);
    expect(result.stderr).not.toContain(CLI_SECRET);
    expect(result.stderr).toContain(
      "sandbox secret values must be provided with --stdin or the masked prompt"
    );
  });

  test("sandbox create sends secret refs and refuses secret-like literals without echoing plaintext", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const result = await runCli([
        "sandbox",
        "create",
        "--env-ref",
        "FOO_API_KEY=openpond://secret/team_test/secret_test#v1",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(CLI_SECRET);
      expect(requests[0]?.url).toBe("/v1/sandboxes");
      expect(requests[0]?.body).toMatchObject({
        env: [
          {
            name: "FOO_API_KEY",
            secretRef: "openpond://secret/team_test/secret_test#v1",
          },
        ],
      });
    });

    const rejected = await runCli([
      "sandbox",
      "create",
      "--env-literal",
      `FOO_API_KEY=${CLI_SECRET}`,
      "--sandbox-api-url",
      "http://127.0.0.1:9/v1/sandboxes",
    ]);

    expect(rejected.code).not.toBe(0);
    expect(rejected.stdout).not.toContain(CLI_SECRET);
    expect(rejected.stderr).not.toContain(CLI_SECRET);
    expect(rejected.stderr).toContain(
      "refusing plaintext value for secret-like env FOO_API_KEY"
    );
  });

  test("sandbox create sends low-level sandbox runtime options", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const result = await runCli([
        "sandbox",
        "create",
        "--workflow-mode",
        "feature",
        "--runtime-project-id",
        "project_test",
        "--runtime-agent-id",
        "agent_test",
        "--runtime-base-branch",
        "master",
        "--runtime-promotion-policy",
        "manual",
        "--runtime-profile-id",
        "openpond-coding-core-v1",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(result.code).toBe(0);
      expect(requests.map((request) => request.url)).toEqual([
        "/v1/runtimes",
        "/v1/runtimes/workspace_test/sandbox",
      ]);
      expect(requests[0]?.body).toMatchObject({
        projectId: "project_test",
        agentId: "agent_test",
        workflowMode: "feature",
        baseBranch: "master",
        promotionPolicy: "manual",
        runtimeProfileId: "openpond-coding-core-v1",
      });
      expect(requests[1]?.body).toMatchObject({
        projectId: "project_test",
        agentId: "agent_test",
        runtimeProfileId: "openpond-coding-core-v1",
      });
      expect("sandboxRuntime" in (requests[1]?.body ?? {})).toBe(false);
      expect("workspacePurpose" in (requests[0]?.body ?? {})).toBe(false);
    });
  });

  test("sandbox create sends image and Dockerfile workload sources", async () => {
    const imageRequests: CapturedRequest[] = [];
    await withSandboxApi(imageRequests, async (sandboxApiUrl) => {
      const result = await runCli([
        "sandbox",
        "create",
        "--image",
        "python:3.12-slim-bookworm",
        "--image-digest",
        `sha256:${"a".repeat(64)}`,
        "--registry-secret-ref",
        "openpond://secret/team_test/registry#v1",
        "--command",
        "python --version",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(result.code).toBe(0);
      expect(imageRequests[0]?.url).toBe("/v1/sandboxes");
      expect(imageRequests[0]?.body).toMatchObject({
        command: "python --version",
        workloadSource: {
          image: {
            ref: "python:3.12-slim-bookworm",
            digest: `sha256:${"a".repeat(64)}`,
            registrySecretRef: "openpond://secret/team_test/registry#v1",
            platform: "linux/amd64",
          },
        },
      });
    });

    const dockerfileRequests: CapturedRequest[] = [];
    const dockerContext = await mkdtemp(
      path.join(os.tmpdir(), "openpond-cli-dockerfile-create-")
    );
    try {
      await writeFile(
        path.join(dockerContext, "Dockerfile"),
        "FROM python:3.12-slim-bookworm\nCOPY app.py /workspace/app.py\n"
      );
      await writeFile(path.join(dockerContext, "app.py"), "print('ok')\n");
      await writeFile(path.join(dockerContext, ".env.local"), "SECRET=skip\n");

      await withSandboxApi(dockerfileRequests, async (sandboxApiUrl) => {
        const result = await runCli(
          [
            "sandbox",
            "create",
            "--dockerfile",
            "Dockerfile",
            "--dockerfile-context",
            ".",
            "--dockerfile-target",
            "runtime",
            "--docker-build-args",
            '{"NODE_VERSION":"20"}',
            "--docker-registry-secret-refs",
            "openpond://secret/team_test/registry#v1",
            "--runtime-workspace-root",
            "/workspace/app",
            "--sandbox-api-url",
            sandboxApiUrl,
          ],
          "",
          { cwd: dockerContext }
        );

        expect(result.code).toBe(0);
        expect(dockerfileRequests[0]?.url).toBe("/v1/sandboxes");
        expect(dockerfileRequests[0]?.body).toMatchObject({
          workloadSource: {
            dockerfile: {
              path: "Dockerfile",
              context: ".",
              target: "runtime",
              buildArgs: { NODE_VERSION: "20" },
              registrySecretRefs: ["openpond://secret/team_test/registry#v1"],
              workspaceRoot: "/workspace/app",
              platform: "linux/amd64",
            },
          },
          sourceArchive: {
            source: "client_upload",
            ref: "client-upload",
          },
        });
        const sourceArchive = dockerfileRequests[0]?.body
          .sourceArchive as Record<string, unknown> | undefined;
        const archive = sourceArchive?.archive as
          | Record<string, unknown>
          | undefined;
        const entries = archive?.entries as
          | Array<Record<string, unknown>>
          | undefined;
        expect(entries?.map((entry) => entry.path).sort()).toEqual([
          "Dockerfile",
          "app.py",
        ]);
      });
    } finally {
      await rm(dockerContext, { recursive: true, force: true });
    }
  });
});
