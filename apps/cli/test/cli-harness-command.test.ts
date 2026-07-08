import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/cli/common";
import {
  buildDesktopHarnessInvocation,
  resolveDesktopHarnessRepoRoot,
} from "../src/cli/harness";

async function makeHarnessRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-harness-root-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "scripts", "desktop-harness.ts"), "");
  return root;
}

describe("CLI desktop harness command", () => {
  test("parses harness --json as a report path without changing global json parsing", () => {
    const harness = parseArgs([
      "harness",
      "desktop",
      "run",
      "tests/desktop-scenarios/chat-two-turns.ts",
      "--json",
      "tmp/desktop-harness/report.json",
    ]);

    expect(harness.command).toBe("harness");
    expect(harness.rest).toEqual([
      "desktop",
      "run",
      "tests/desktop-scenarios/chat-two-turns.ts",
    ]);
    expect(harness.options.json).toBe("tmp/desktop-harness/report.json");

    expect(() => parseArgs(["profile", "current", "--json=maybe"])).toThrow(
      /json must be a boolean/
    );
  });

  test("builds a bun desktop harness invocation from parsed CLI options", async () => {
    const root = await makeHarnessRoot();
    try {
      const invocation = await buildDesktopHarnessInvocation({
        cwd: path.join(root, "scripts"),
        env: { BUN_BINARY: "/custom/bun" },
        rest: [
          "desktop",
          "run",
          "tests/desktop-scenarios/chat-two-turns.ts",
          "tests/desktop-scenarios/subagent-visible-lifecycle.ts",
        ],
        options: {
          artifactsDir: "tmp/desktop-harness/phase4",
          grep: "subagent|chat",
          isolated: "true",
          json: "tmp/desktop-harness/phase4/report.json",
          keepHome: "true",
          timeoutMs: "150000",
        },
      });

      expect(invocation).toEqual({
        command: "/custom/bun",
        cwd: root,
        args: [
          "scripts/desktop-harness.ts",
          "run",
          "tests/desktop-scenarios/chat-two-turns.ts",
          "tests/desktop-scenarios/subagent-visible-lifecycle.ts",
          "--isolated",
          "--artifacts-dir",
          "tmp/desktop-harness/phase4",
          "--json",
          "tmp/desktop-harness/phase4/report.json",
          "--grep",
          "subagent|chat",
          "--timeout-ms",
          "150000",
          "--keep-home",
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps desktop attach shorthand to the harness attach launch mode", async () => {
    const root = await makeHarnessRoot();
    try {
      const invocation = await buildDesktopHarnessInvocation({
        cwd: root,
        rest: ["desktop", "attach", "scenario.ts"],
        options: {
          devtoolsPort: "9333",
          jsonPath: "tmp/report.json",
          server: "http://127.0.0.1:4317",
          tokenFile: "tmp/token",
        },
      });

      expect(invocation.args).toEqual([
        "scripts/desktop-harness.ts",
        "run",
        "scenario.ts",
        "--attach",
        "--server",
        "http://127.0.0.1:4317",
        "--token-file",
        "tmp/token",
        "--devtools-port",
        "9333",
        "--json",
        "tmp/report.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes packaged launch mode and app path through to the runner", async () => {
    const root = await makeHarnessRoot();
    try {
      const invocation = await buildDesktopHarnessInvocation({
        cwd: root,
        rest: ["desktop", "run", "tests/desktop-scenarios/chat-two-turns.ts"],
        options: {
          app: "release/linux-unpacked/openpond",
          packaged: "true",
        },
      });

      expect(invocation.args).toEqual([
        "scripts/desktop-harness.ts",
        "run",
        "tests/desktop-scenarios/chat-two-turns.ts",
        "--packaged",
        "--app",
        "release/linux-unpacked/openpond",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("walks upward to find the OpenPond harness root", async () => {
    const root = await makeHarnessRoot();
    try {
      const nested = path.join(root, "apps", "cli");
      await mkdir(nested, { recursive: true });
      await expect(resolveDesktopHarnessRepoRoot(nested)).resolves.toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
