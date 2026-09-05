import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { parseArgs } from "../src/cli/common";
import {
  buildDesktopHarnessInvocation,
  resolveDesktopHarnessRepoRoot,
} from "../src/cli/desktop-test";

async function makeHarnessRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-harness-root-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "scripts", "desktop-harness.ts"), "");
  return root;
}

describe("CLI desktop test command", () => {
  test("parses desktop-test --json as a report path without changing global json parsing", () => {
    const desktopTest = parseArgs([
      "desktop-test",
      "run",
      "tests/desktop-scenarios/chat-two-turns.ts",
      "--json",
      "tmp/desktop-harness/report.json",
    ]);

    expect(desktopTest.command).toBe("desktop-test");
    expect(desktopTest.rest).toEqual([
      "run",
      "tests/desktop-scenarios/chat-two-turns.ts",
    ]);
    expect(desktopTest.options.json).toBe("tmp/desktop-harness/report.json");

    expect(() => parseArgs(["profile", "current", "--json=maybe"])).toThrow(
      /json must be a boolean/
    );
  });

  test("builds a Node desktop harness invocation from parsed CLI options", async () => {
    const root = await makeHarnessRoot();
    try {
      const invocation = await buildDesktopHarnessInvocation({
        cwd: path.join(root, "scripts"),
        env: { OPENPOND_NODE_BINARY: "/custom/node" },
        rest: [
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

      expect(invocation.command).toBe("/custom/node");
      expect(invocation.cwd).toBe(root);
      expect(invocation.args[0]).toContain("tsx");
      expect(invocation.args.slice(1)).toEqual([
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
        ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps desktop attach shorthand to the harness attach launch mode", async () => {
    const root = await makeHarnessRoot();
    try {
      const invocation = await buildDesktopHarnessInvocation({
        cwd: root,
        rest: ["attach", "scenario.ts"],
        options: {
          devtoolsPort: "9333",
          jsonPath: "tmp/report.json",
          server: "http://127.0.0.1:4317",
          tokenFile: "tmp/token",
        },
      });

      expect(invocation.args[0]).toContain("tsx");
      expect(invocation.args.slice(1)).toEqual([
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
        rest: ["run", "tests/desktop-scenarios/chat-two-turns.ts"],
        options: {
          app: "release/linux-unpacked/openpond-desktop",
          packaged: "true",
        },
      });

      expect(invocation.args[0]).toContain("tsx");
      expect(invocation.args.slice(1)).toEqual([
        "scripts/desktop-harness.ts",
        "run",
        "tests/desktop-scenarios/chat-two-turns.ts",
        "--packaged",
        "--app",
        "release/linux-unpacked/openpond-desktop",
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
