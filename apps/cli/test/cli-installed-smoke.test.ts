import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { runProcessCommand } from "../src/process-runner";

const cliRoot = join(import.meta.dirname, "..");
const RELEASE_AGENT_PROTOCOL_VERSION = "2026-08-26";

type CliPackageJson = {
  bin?: Record<string, string>;
};

async function readCliPackageJson(): Promise<CliPackageJson> {
  return JSON.parse(
    await readFile(join(cliRoot, "package.json"), "utf-8")
  ) as CliPackageJson;
}

describe("CLI installed-package smoke", () => {
  let packageJson: CliPackageJson;

  beforeAll(async () => {
    packageJson = await readCliPackageJson();
  });

  test("starts the embedded local server companion from an unrelated cwd", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "openpond-installed-cli-cwd-"));
    const appHome = await mkdtemp(join(os.tmpdir(), "openpond-installed-cli-home-"));
    try {
      const result = await runProcessCommand(
        "node",
        [join(cliRoot, packageJson.bin!.openpond!), "serve", "--port", "0"],
        {
          cwd,
          env: {
            OPENPOND_HOME: appHome,
            OPENPOND_FORCE_EMBEDDED_COMPANIONS: "1",
          },
          timeoutMs: 10_000,
          terminateWhenStdoutIncludes: "OPENPOND_APP_SERVER_READY ",
        },
      );
      const diagnostics = [
        `exit code: ${result.code ?? "none"}`,
        `signal: ${result.signal ?? "none"}`,
        `termination: ${result.terminationReason}`,
        `stderr: ${result.stderr.trim() || "<empty>"}`,
      ].join("\n");
      expect(result.stdout, diagnostics).toContain("OPENPOND_APP_SERVER_READY");
      expect(result.terminationReason, diagnostics).toBe("output");
    } finally {
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(appHome, { recursive: true, force: true }),
      ]);
    }
  });

  test("runs the lean embedded app-server companion over JSONL", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "openpond-installed-app-server-cwd-"));
    const expectedCwd = await realpath(cwd);
    const storeDir = await mkdtemp(join(os.tmpdir(), "openpond-installed-app-server-state-"));
    try {
      const stdin = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: RELEASE_AGENT_PROTOCOL_VERSION,
            client: { name: "installed-cli-smoke", version: "1" },
          },
        },
        { jsonrpc: "2.0", method: "initialized" },
        { jsonrpc: "2.0", id: 2, method: "runtime/capabilities", params: {} },
        { jsonrpc: "2.0", id: 3, method: "harness/validate", params: {} },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "thread/start",
          params: {
            session: {
              provider: "openpond",
              modelRef: {
                providerId: "openpond",
                modelId: "openpond-chat",
              },
              experience: "work",
              title: "Installed app-server cwd proof",
            },
          },
        },
      ].map((message) => JSON.stringify(message)).join("\n") + "\n";
      const result = await runProcessCommand(
        "node",
        [
          join(cliRoot, packageJson.bin!.openpond!),
          "app-server",
          "--home",
          storeDir,
        ],
        {
          cwd,
          env: {
            OPENPOND_FORCE_EMBEDDED_COMPANIONS: "1",
            OPENPOND_HARNESS_SCRIPTED_MODELS: "1",
          },
          stdin,
          timeoutMs: 20_000,
        },
      );
      expect(result.code).toBe(0);
      expect(result.stderr.trim()).toBe("");
      const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(messages).toHaveLength(5);
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 2,
          result: expect.objectContaining({ placement: "hosted_work" }),
        }),
        expect.objectContaining({
          id: 3,
          result: expect.objectContaining({ valid: true }),
        }),
        expect.objectContaining({
          id: 4,
          result: {
            thread: expect.objectContaining({ cwd: expectedCwd }),
          },
        }),
      ]));
      expect(result.stdout).not.toContain("OPENPOND_APP_SERVER_READY");
      expect(result.stdout).not.toContain("OpenPond API server");
    } finally {
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(storeDir, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);

});
