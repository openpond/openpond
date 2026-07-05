import { describe, expect, test } from "bun:test";

import { createOpenPondSandboxClient } from "../src/sandbox/client";
import { CLI_SECRET, type CapturedRequest, runCli, withSandboxApi } from "./cli-sandbox-fixture";

describe("sandbox runtime and lifecycle CLI scenarios", () => {
  test("sandbox runtime inspection commands read runtime status and events", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const list = await runCli([
        "sandbox",
        "runtime-list",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const runtime = await runCli([
        "sandbox",
        "runtime-get",
        "workspace_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const events = await runCli([
        "sandbox",
        "runtime-events",
        "workspace_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const eventWrite = await runCli([
        "sandbox",
        "runtime-event",
        "workspace_test",
        "--type",
        "workflow.checkpoint_hint",
        "--summary",
        "checkpoint",
        "--payload",
        '{"artifact":"conversation-state"}',
        "--lifecycle-hint",
        '{"kind":"checkpoint","reason":"no_user_reply_timeout"}',
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const statusWrite = await runCli([
        "sandbox",
        "runtime-status",
        "workspace_test",
        "--status",
        "waiting_for_user",
        "--expected-version",
        "2",
        "--summary",
        "waiting",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(list.code).toBe(0);
      expect(runtime.code).toBe(0);
      expect(events.code).toBe(0);
      expect(eventWrite.code).toBe(0);
      expect(statusWrite.code).toBe(0);
      expect(JSON.parse(list.stdout).runtimes).toContainEqual(
        expect.objectContaining({
          id: "workspace_test",
          status: "waiting_for_user",
        })
      );
      expect(JSON.parse(runtime.stdout).runtime).toMatchObject({
        id: "workspace_test",
        status: "waiting_for_user",
      });
      expect(JSON.parse(events.stdout).events).toEqual([
        expect.objectContaining({
          type: "workflow.waiting_for_user",
        }),
      ]);
      expect(JSON.parse(eventWrite.stdout).event).toMatchObject({
        type: "workflow.checkpoint_hint",
      });
      expect(JSON.parse(statusWrite.stdout).runtime).toMatchObject({
        id: "workspace_test",
        status: "waiting_for_user",
      });
      expect(requests.map((request) => request.url)).toContain("/v1/runtimes");
      expect(requests.map((request) => request.url)).toContain(
        "/v1/runtimes/workspace_test"
      );
      expect(requests.map((request) => request.url)).toContain(
        "/v1/runtimes/workspace_test/events"
      );
      expect(
        requests.some(
          (request) =>
            request.method === "PATCH" &&
            request.url === "/v1/runtimes/workspace_test/status"
        )
      ).toBe(true);
    });
  });

  test("sdk project runtime helpers materialize and resume attached sandboxes", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const client = createOpenPondSandboxClient({
        apiKey: "opk_test_cli",
        sandboxApiUrl,
      });

      const createdRuntime = await client.runtimes.create({
        projectId: "project_test",
        agentId: "agent_test",
        workflowMode: "feature",
      });
      const runtime = client.runtimes.handle(createdRuntime.id, createdRuntime);
      await runtime.createSandbox({
        projectId: "project_test",
        agentId: "agent_test",
        command: "echo ready",
      });
      const exec = await runtime.commands.run("echo hi");
      const fileWrite = await runtime.files.write(
        "src/message.txt",
        "hello from runtime files"
      );
      const fileRead = await runtime.files.read("src/message.txt");
      const waiting = await runtime.waitForUser({
        reason: "awaiting_next_prompt",
      });
      const rawSandbox = await client.sandboxes.create({
        command: "echo raw",
      });

      expect(runtime.id).toBe("workspace_test");
      expect(exec.command.command).toBe("echo hi");
      expect(fileWrite.file.path).toBe("src/message.txt");
      expect(fileRead).toBe("hello from runtime files");
      expect(waiting.status).toBe("waiting_for_user");
      expect(rawSandbox.runtimeId).toBeNull();
      expect(requests.map((request) => request.url)).toEqual([
        "/v1/runtimes",
        "/v1/runtimes/workspace_test/sandbox",
        "/v1/runtimes/workspace_test",
        "/v1/sandboxes/sandbox_test",
        "/v1/sandboxes/sandbox_test/exec",
        "/v1/runtimes/workspace_test",
        "/v1/sandboxes/sandbox_test",
        "/v1/sandboxes/sandbox_test/files",
        "/v1/runtimes/workspace_test",
        "/v1/sandboxes/sandbox_test",
        "/v1/sandboxes/sandbox_test/files?path=src%2Fmessage.txt",
        "/v1/runtimes/workspace_test/events",
        "/v1/runtimes/workspace_test",
        "/v1/sandboxes",
      ]);
      expect(requests[0]?.body).toMatchObject({
        projectId: "project_test",
        agentId: "agent_test",
        workflowMode: "feature",
      });
      expect(requests[1]?.body).toMatchObject({
        projectId: "project_test",
        agentId: "agent_test",
        command: "echo ready",
      });
      expect(requests[4]?.body).toMatchObject({
        command: "echo hi",
      });
      expect(requests[7]?.body).toMatchObject({
        path: "src/message.txt",
      });
      expect(requests[11]?.body).toMatchObject({
        type: "workflow.waiting_for_user",
        lifecycleHint: {
          kind: "waiting_for_user",
          reason: "awaiting_next_prompt",
        },
      });
    });
  });

  test("sandbox SDK and CLI expose patch export, source preservation, and guarded lifecycle", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const client = createOpenPondSandboxClient({
        apiKey: "opk_test_cli",
        sandboxApiUrl,
      });

      const exported = await client.gitExportPatch("sandbox_test", {
        baseRef: "openpond/base",
      });
      const preserved = await client.runtimes.preserveSource(
        "workspace_test",
        {
          sandboxId: "sandbox_test",
          message: "Preserve hosted changes",
        },
        { teamId: "team_test" }
      );
      await client.stop("sandbox_test", {
        failOnUnpreservedChanges: true,
      });
      await client.delete("sandbox_test", {
        failOnUnpreservedChanges: true,
      });

      const cliPatch = await runCli([
        "sandbox",
        "git-export-patch",
        "sandbox_test",
        "--base-ref",
        "openpond/base",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const cliPreserve = await runCli([
        "sandbox",
        "runtime-preserve-source",
        "workspace_test",
        "--team-id",
        "team_test",
        "--sandbox-id",
        "sandbox_test",
        "--message",
        "Preserve hosted changes",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const cliStop = await runCli([
        "sandbox",
        "stop",
        "sandbox_test",
        "--fail-on-unpreserved-changes",
        "--async",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const cliDelete = await runCli([
        "sandbox",
        "delete",
        "sandbox_test",
        "--fail-on-unpreserved-changes",
        "--respond-async",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(exported.patch.sha256).toBe("a".repeat(64));
      expect(preserved.preservedSha).toBe("feed123");
      for (const result of [cliPatch, cliPreserve, cliStop, cliDelete]) {
        expect(result.code).toBe(0);
      }
      expect(JSON.parse(cliPatch.stdout).patch.sha256).toBe("a".repeat(64));
      expect(JSON.parse(cliPreserve.stdout).preservedSha).toBe("feed123");
      expect(requests.map((request) => request.url)).toEqual([
        "/v1/sandboxes/sandbox_test/git/export-patch",
        "/v1/runtimes/workspace_test/preserve-source?teamId=team_test",
        "/v1/sandboxes/sandbox_test/stop?failOnUnpreservedChanges=true",
        "/v1/sandboxes/sandbox_test?failOnUnpreservedChanges=true",
        "/v1/sandboxes/sandbox_test/git/export-patch",
        "/v1/runtimes/workspace_test/preserve-source?teamId=team_test",
        "/v1/sandboxes/sandbox_test/stop?failOnUnpreservedChanges=true",
        "/v1/sandboxes/sandbox_test?failOnUnpreservedChanges=true",
      ]);
      expect(requests[0]?.body).toEqual({ baseRef: "openpond/base" });
      expect(requests[1]?.body).toEqual({
        sandboxId: "sandbox_test",
        message: "Preserve hosted changes",
      });
      expect(requests[4]?.body).toEqual({ baseRef: "openpond/base" });
      expect(requests[5]?.body).toEqual({
        sandboxId: "sandbox_test",
        message: "Preserve hosted changes",
      });
      expect(requests[6]?.prefer).toBe("respond-async");
      expect(requests[7]?.prefer).toBe("respond-async");
    });
  });

  test("sandbox pricing and costs expose tier and runner slot accounting", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const pricing = await runCli([
        "sandbox",
        "pricing",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const costs = await runCli([
        "sandbox",
        "costs",
        "--team-id",
        "team_test",
        "--summary",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(pricing.code).toBe(0);
      expect(costs.code).toBe(0);
      expect(JSON.parse(pricing.stdout).pricing).toMatchObject({
        currency: "USD",
        tiers: [
          expect.objectContaining({
            key: "default",
            keepRunningEstimate: expect.objectContaining({
              monthlyUsd: "41.990400",
            }),
          }),
        ],
      });
      expect(JSON.parse(costs.stdout).costs).toMatchObject({
        teamId: "team_test",
        summary: {
          activeRunnerSlots: 1,
          runningCount: 1,
          stoppedCount: 2,
        },
        lineItems: [
          expect.objectContaining({
            label: "vCPU",
            amountUsd: "0.000042",
          }),
        ],
      });
      expect(requests.map((request) => request.url)).toContain(
        "/v1/sandboxes/pricing"
      );
      expect(requests.map((request) => request.url)).toContain(
        "/v1/sandboxes/costs?teamId=team_test"
      );
    });
  });

  test("created secret refs can be reused to launch a sandbox without echoing plaintext", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const created = await runCli(
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
      expect(created.code).toBe(0);
      expect(created.stdout).not.toContain(CLI_SECRET);
      expect(created.stderr).not.toContain(CLI_SECRET);

      const secretRef = (
        JSON.parse(created.stdout) as { secret: { secretRef: string } }
      ).secret.secretRef;
      const launched = await runCli([
        "sandbox",
        "create",
        "--env-ref",
        `FOO_API_KEY=${secretRef}`,
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      expect(launched.code).toBe(0);
      expect(launched.stdout).not.toContain(CLI_SECRET);
      expect(launched.stderr).not.toContain(CLI_SECRET);
      expect(requests.map((request) => request.url)).toEqual([
        "/v1/sandbox-secrets",
        "/v1/sandboxes",
      ]);
      expect(requests[1]?.body).toMatchObject({
        env: [{ name: "FOO_API_KEY", secretRef }],
      });
    });
  });

  test("secret list, attach, rotate, revoke, and delete stay metadata-only", async () => {
    const requests: CapturedRequest[] = [];
    await withSandboxApi(requests, async (sandboxApiUrl) => {
      const listed = await runCli([
        "sandbox",
        "secrets",
        "--json",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const attached = await runCli([
        "sandbox",
        "secret-attach",
        "secret_test",
        "--env-name",
        "FOO_API_KEY",
        "--target-type",
        "sandbox",
        "--target-id",
        "sandbox_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const rotated = await runCli(
        [
          "sandbox",
          "secret-rotate",
          "secret_test",
          "--stdin",
          "--sandbox-api-url",
          sandboxApiUrl,
        ],
        `${CLI_SECRET}\n`
      );
      const revoked = await runCli([
        "sandbox",
        "secret-revoke",
        "secret_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);
      const deleted = await runCli([
        "sandbox",
        "secret-delete",
        "secret_test",
        "--sandbox-api-url",
        sandboxApiUrl,
      ]);

      for (const result of [listed, attached, rotated, revoked, deleted]) {
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(CLI_SECRET);
        expect(result.stderr).not.toContain(CLI_SECRET);
        expect(result.stdout).toContain(
          "openpond://secret/team_test/secret_test"
        );
      }
      expect(
        requests.map((request) => `${request.method} ${request.url}`)
      ).toEqual([
        "GET /v1/sandbox-secrets",
        "POST /v1/sandbox-secrets/secret_test/attach",
        "POST /v1/sandbox-secrets/secret_test/rotate",
        "POST /v1/sandbox-secrets/secret_test/revoke",
        "DELETE /v1/sandbox-secrets/secret_test",
      ]);
      expect(requests[1]?.body).toMatchObject({
        envName: "FOO_API_KEY",
        targetType: "sandbox",
        targetId: "sandbox_test",
      });
      expect(requests[2]?.body).toMatchObject({
        value: CLI_SECRET,
      });
    });
  });
});
