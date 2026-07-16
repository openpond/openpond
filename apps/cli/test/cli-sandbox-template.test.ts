import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { CLI_SECRET, type CapturedRequest, runCli, withSandboxApi } from "./cli-sandbox-fixture";

describe("sandbox template CLI scenarios", () => {
  test("sandbox template uploads reject .env files before reading them", async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-cli-env-upload-")
    );
    try {
      await writeFile(
        path.join(projectDir, "openpond.yaml"),
        [
          "schemaVersion: 1",
          "name: env-upload-test",
          "version: 0.0.1",
          "useCase: sandbox-template-example",
          "description: Upload guard test.",
          "runtime:",
          "  base: node-bun-workspace",
          "resources:",
          "  cpu: 1",
          "  memoryGb: 1",
          "  diskGb: 4",
          "start:",
          "  command: node index.ts",
          "actions: []",
          "services: []",
          "validation:",
          "  commands:",
          "    - test -f openpond.yaml",
          "inputs:",
          "  schema:",
          "    type: object",
          "    required:",
          "      - credentials",
          "    properties:",
          "      credentials:",
          "        type: string",
          "        x-openpond-upload:",
          "          targetPath: uploads",
          "",
        ].join("\n"),
        "utf8"
      );

      const result = await runCli(
        [
          "sandbox-template",
          "start",
          "--input-file",
          "credentials=.env.local",
          "--sandbox-api-url",
          "http://127.0.0.1:9/v1/sandboxes",
        ],
        "",
        { cwd: projectDir }
      );

      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain(CLI_SECRET);
      expect(result.stderr).not.toContain(CLI_SECRET);
      expect(result.stderr).toContain(
        "sandbox template uploads cannot include .env* files"
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("sandbox template env requirements validate without raw values", async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-cli-env-manifest-")
    );
    try {
      const manifestPath = path.join(projectDir, "openpond.yaml");
      const baseManifest = [
        "schemaVersion: 1",
        "name: env-manifest-test",
        "version: 0.0.1",
        "useCase: sandbox-template-example",
        "description: Env manifest guard test.",
        "runtime:",
        "  base: node-bun-workspace",
        "resources:",
        "  cpu: 1",
        "  memoryGb: 1",
        "  diskGb: 4",
        "start:",
        "  command: node index.ts",
        "actions: []",
        "services: []",
        "validation:",
        "  commands:",
        "    - test -f openpond.yaml",
        "inputs:",
        "  schema:",
        "    type: object",
        "  env:",
        "    - name: FOO_API_KEY",
        "      required: true",
        "      secret: true",
        "      description: API key for FOO.",
        "",
      ].join("\n");
      await writeFile(manifestPath, baseManifest, "utf8");

      const valid = await runCli(["sandbox-template", "validate"], "", {
        cwd: projectDir,
      });
      expect(valid.code).toBe(0);

      await writeFile(
        manifestPath,
        baseManifest.replace(
          "      description: API key for FOO.",
          "      value: should-not-be-here"
        ),
        "utf8"
      );
      const invalid = await runCli(["sandbox-template", "validate"], "", {
        cwd: projectDir,
      });
      expect(invalid.code).not.toBe(0);
      expect(invalid.stdout).not.toContain(CLI_SECRET);
      expect(invalid.stderr).not.toContain(CLI_SECRET);
      expect(invalid.stderr).toContain('Unrecognized key: "value"');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("sandbox template start accepts input object schemas without properties", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const projectDir = await mkdtemp(
        path.join(os.tmpdir(), "openpond-cli-empty-inputs-")
      );
      try {
        await writeFile(
          path.join(projectDir, "openpond.yaml"),
          [
            "schemaVersion: 1",
            "name: empty-input-start",
            "version: 0.0.1",
            "useCase: sandbox-template-example",
            "description: Empty input schema start test.",
            "runtime:",
            "  base: node-bun-workspace",
            "resources:",
            "  cpu: 1",
            "  memoryGb: 1",
            "  diskGb: 4",
            "start:",
            "  command: echo scheduled",
            "actions: []",
            "services: []",
            "validation:",
            "  commands:",
            "    - test -f openpond.yaml",
            "inputs:",
            "  schema:",
            "    type: object",
            "schedules:",
            "  - name: daily-start",
            "    rate: 1 day",
            "    target:",
            "      kind: start",
            "",
          ].join("\n"),
          "utf8"
        );

        const result = await runCli(
          [
            "sandbox-template",
            "start",
            "--repo",
            "https://github.com/octocat/Hello-World",
            "--enable-schedules",
            "daily-start",
            "--sandbox-api-url",
            sandboxApiUrl,
          ],
          "",
          { cwd: projectDir }
        );

        expect(result.code).toBe(0);
        const scheduleRequest = requests.find(
          (request) =>
            request.method === "POST" &&
            request.url === "/v1/sandboxes/schedules"
        );
        expect(scheduleRequest?.body).toMatchObject({
          sourceSandboxId: "sandbox_test",
          name: "daily-start",
          scheduleType: "rate",
          scheduleExpression: "rate(1 day)",
          target: {
            kind: "command",
            command: "echo scheduled",
          },
        });
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("sandbox template start sends network, env refs, and sandbox runtime options", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const projectDir = await mkdtemp(
        path.join(os.tmpdir(), "openpond-cli-template-agent-")
      );
      try {
        await writeFile(
          path.join(projectDir, "openpond.yaml"),
          [
            "schemaVersion: 1",
            "name: agent-template-start",
            "version: 0.0.1",
            "useCase: sandbox-template-example",
            "description: Sandbox runtime template start test.",
            "runtime:",
            "  base: node-bun-workspace",
            "resources:",
            "  cpu: 1",
            "  memoryGb: 1",
            "  diskGb: 4",
            "start:",
            "  command: echo ok",
            "actions: []",
            "services: []",
            "validation:",
            "  commands:",
            "    - test -f openpond.yaml",
            "inputs:",
            "  schema:",
            "    type: object",
            "  env:",
            "    - name: FOO_API_KEY",
            "      required: true",
            "      secret: true",
            "network:",
            "  egress: allow",
            "",
          ].join("\n"),
          "utf8"
        );

        const result = await runCli(
          [
            "sandbox-template",
            "start",
            "--repo",
            "https://github.com/octocat/Hello-World",
            "--env-ref",
            "FOO_API_KEY=openpond://secret/team_test/secret_test#v1",
            "--workflow-mode",
            "attempt",
            "--runtime-project-id",
            "project_test",
            "--runtime-agent-id",
            "agent_test",
            "--runtime-base-branch",
            "master",
            "--runtime-promotion-policy",
            "manual",
            "--sandbox-api-url",
            sandboxApiUrl,
          ],
          "",
          { cwd: projectDir }
        );

        expect(result.code).toBe(0);
        const workspaceRequest = requests.find(
          (request) =>
            request.method === "POST" && request.url === "/v1/runtimes"
        );
        expect(workspaceRequest?.body).toMatchObject({
          projectId: "project_test",
          agentId: "agent_test",
            workflowMode: "attempt",
          baseBranch: "master",
          promotionPolicy: "manual",
        });
        const createRequest = requests.find(
          (request) =>
            request.method === "POST" &&
            request.url === "/v1/runtimes/workspace_test/sandbox"
        );
        expect(createRequest?.body).toMatchObject({
          projectId: "project_test",
          agentId: "agent_test",
          env: [
            {
              name: "FOO_API_KEY",
              secretRef: "openpond://secret/team_test/secret_test#v1",
            },
          ],
          networkPolicy: {
            internetEgress: "allow",
          },
        });
        expect("sandboxRuntime" in (createRequest?.body ?? {})).toBe(false);
        const processRequest = requests.find(
          (request) =>
            request.method === "POST" &&
            request.url === "/v1/sandboxes/sandbox_test/processes"
        );
        expect(processRequest?.body.command).toContain(
          "OPENPOND_SANDBOX_RUNTIME_ID='workspace_test'"
        );
        expect(processRequest?.body.command).toContain(
          "OPENPOND_SANDBOX_ID='sandbox_test'"
        );
        expect(result.stdout).not.toContain(CLI_SECRET);
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  test("sandbox template start sends Dockerfile workload source", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const projectDir = await mkdtemp(
        path.join(os.tmpdir(), "openpond-cli-template-dockerfile-")
      );
      try {
        await writeFile(
          path.join(projectDir, "openpond.yaml"),
          [
            "schemaVersion: 1",
            "name: dockerfile-template-start",
            "version: 0.0.1",
            "useCase: sandbox-template-example",
            "description: Dockerfile template start test.",
            "runtime:",
            "  dockerfile:",
            "    context: .",
            "    path: Dockerfile",
            "    target: runtime",
            "    buildArgs:",
            "      NODE_VERSION: \"20\"",
            "resources:",
            "  cpu: 1",
            "  memoryGb: 1",
            "  diskGb: 4",
            "start:",
            "  command: node app.js",
            "actions: []",
            "services: []",
            "validation:",
            "  commands:",
            "    - test -f Dockerfile",
            "",
          ].join("\n"),
          "utf8"
        );
        await writeFile(
          path.join(projectDir, "Dockerfile"),
          "FROM node:20\n",
          "utf8"
        );

        const result = await runCli(
          [
            "sandbox-template",
            "start",
            "--repo",
            "https://github.com/octocat/Hello-World",
            "--sandbox-api-url",
            sandboxApiUrl,
          ],
          "",
          { cwd: projectDir }
        );

        expect(result.code).toBe(0);
        const createRequest = requests.find(
          (request) =>
            request.method === "POST" && request.url === "/v1/sandboxes"
        );
        expect(createRequest?.body).toMatchObject({
          workloadSource: {
            dockerfile: {
              context: ".",
              path: "Dockerfile",
              target: "runtime",
              buildArgs: { NODE_VERSION: "20" },
            },
          },
        });
        const processRequest = requests.find(
          (request) =>
            request.method === "POST" &&
            request.url === "/v1/sandboxes/sandbox_test/processes"
        );
        expect(processRequest?.body.command).toContain("node app.js");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });
});
