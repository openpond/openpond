import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";

import { listCliCommandDefinitions } from "../src/cli/command-registry";
import { runProcessCommand } from "../src/process-runner";

const cliRoot = join(import.meta.dir, "..");

type CliPackageJson = {
  version: string;
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

  test("runs from a source checkout TypeScript entrypoint", async () => {
    const result = await runProcessCommand(
      process.execPath,
      ["run", "src/cli/main.ts", "--version"],
      { cwd: cliRoot }
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr.trim()).toBe("");
  });

  test("runs the built dist bin entrypoint under Node", async () => {
    const binPath = packageJson.bin?.openpond;
    expect(binPath).toBe("dist/cli.js");

    const result = await runProcessCommand("node", [join(cliRoot, binPath!), "--version"], {
      cwd: cliRoot,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr.trim()).toBe("");
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
            OPENPOND_APP_HOME: appHome,
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

  test(
    "prints help for every documented command group from the built dist bin",
    async () => {
      const binPath = packageJson.bin?.openpond;
      expect(binPath).toBe("dist/cli.js");

      for (const definition of listCliCommandDefinitions()) {
        const result = await runProcessCommand(
          "node",
          [join(cliRoot, binPath!), definition.name, "--help"],
          { cwd: cliRoot }
        );

        expect(result.code, definition.name).toBe(0);
        expect(result.timedOut, definition.name).toBe(false);
        expect(result.stderr.trim(), definition.name).toBe("");
        expect(result.stdout, definition.name).toContain("Usage:");
        expect(result.stdout, definition.name).toContain(definition.usage);
      }
    },
    30_000
  );

  test("prints canonical help for documented command aliases from the built dist bin", async () => {
    const binPath = packageJson.bin?.openpond;
    expect(binPath).toBe("dist/cli.js");

    for (const definition of listCliCommandDefinitions()) {
      for (const alias of definition.aliases ?? []) {
        const result = await runProcessCommand(
          "node",
          [join(cliRoot, binPath!), alias, "--help"],
          { cwd: cliRoot }
        );

        expect(result.code, alias).toBe(0);
        expect(result.timedOut, alias).toBe(false);
        expect(result.stderr.trim(), alias).toBe("");
        expect(result.stdout, alias).toContain("Usage:");
        expect(result.stdout, alias).toContain(definition.usage);
        expect(result.stdout, alias).toContain("Aliases:");
        expect(result.stdout, alias).toContain(alias);
      }
    }
  });
});
