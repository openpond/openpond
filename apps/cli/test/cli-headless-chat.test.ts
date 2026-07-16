import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { runProcessCommand } from "../src/process-runner";
import { startFetchTestServer } from "../../../tests/helpers/fetch-test-server";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ROOT = path.join(REPO_ROOT, "apps", "cli");
const pnpmBinary = process.env.PNPM_BINARY || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
const tsxBinary = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

describe("CLI headless chat", () => {
  beforeAll(async () => {
    if (process.env.OPENPOND_TEST_REUSE_BUILD === "1") return;
    const build = await runProcessCommand(pnpmBinary, ["run", "cli:build"], {
      cwd: REPO_ROOT,
      timeoutMs: 120_000,
    });
    if (build.code !== 0) {
      throw new Error(build.stderr || build.stdout || "CLI build failed");
    }
  });

  test("source TypeScript entrypoint runs one noninteractive JSON turn through the terminal child", async () => {
    await expectCliHeadlessChat([
      path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
      "chat",
    ], { expectedPrompt: "Run this from the CLI" });
  });

  test("built dist bin runs one noninteractive JSON turn from a source checkout", async () => {
    await expectCliHeadlessChat([
      path.join(CLI_ROOT, "dist", "cli.js"),
      "chat",
    ], { command: "node", expectedPrompt: "Run this from the CLI" });
  });

  test("message-file input is resolved relative to the caller cwd before terminal launch", async () => {
    await expectCliHeadlessChat([
      path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
      "chat",
    ], {
      inputMode: "message-file",
      expectedPrompt: "Run this from a relative instruction file.",
    });
  });

  test("benchmark-style invocation forwards cwd, instruction file, provider model, and trust controls", async () => {
    const fake = await startCliHeadlessChatFakeServer([
      runtimeEvent({
        id: "event-assistant",
        name: "assistant.delta",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "Benchmark task complete.",
      }),
      runtimeEvent({
        id: "event-completed",
        name: "turn.completed",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "done",
      }),
    ]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-benchmark-shape-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    const instructionPath = path.join(tempRoot, "instruction.md");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");
    await writeFile(instructionPath, "Solve the benchmark task.\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--cwd",
          taskDir,
          "--message-file",
          instructionPath,
          "--provider",
          "codex",
          "--model",
          "gpt-5.5",
          "--non-interactive",
          "--yes",
          "--json",
          "--timeout-sec",
          "30",
          "--max-output-bytes",
          "1024",
          "--sandbox",
          "danger-full-access",
          "--no-server-start",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 10_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const printed = JSON.parse(result.stdout) as {
        status?: string;
        provider?: string;
        model?: string;
        cwd?: string;
        finalMessage?: string;
        output?: { maxOutputBytes?: number | null };
      };
      expect(printed).toMatchObject({
        status: "completed",
        provider: "codex",
        model: "gpt-5.5",
        cwd: taskDir,
        finalMessage: "Benchmark task complete.",
      });
      expect(printed.output?.maxOutputBytes).toBe(1024);
      expect(fake.turnRequests).toHaveLength(1);
      expect(fake.turnRequests[0]).toMatchObject({
        prompt: "Solve the benchmark task.",
        cwd: taskDir,
        model: "gpt-5.5",
        modelRef: { providerId: "codex", modelId: "gpt-5.5" },
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("stdin input reaches the one-shot terminal child", async () => {
    await expectCliHeadlessChat([
      path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
      "chat",
    ], {
      inputMode: "stdin",
      expectedPrompt: "Run this from stdin.",
    });
  });

  test("piped noninteractive input is treated as one-shot stdin", async () => {
    await expectCliHeadlessChat([
      path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
      "chat",
    ], {
      inputMode: "implicit-stdin",
      expectedPrompt: "Run this from an implicit pipe.",
    });
  });

  test("explicit approval and sandbox flags are forwarded to the terminal turn", async () => {
    const fake = await startCliHeadlessChatFakeServer([
      runtimeEvent({
        id: "event-completed",
        name: "turn.completed",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "done",
      }),
    ]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-trust-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");
    const expectedCwd = await realpath(taskDir);

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run trusted benchmark task",
          "--non-interactive",
          "--json",
          "--approval-policy",
          "never",
          "--sandbox",
          "danger-full-access",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(fake.turnRequests).toHaveLength(1);
      expect(fake.turnRequests[0]).toMatchObject({
        prompt: "Run trusted benchmark task",
        cwd: expectedCwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("max-output-bytes caps final JSON output through the CLI wrapper", async () => {
    const fake = await startCliHeadlessChatFakeServer([
      runtimeEvent({
        id: "event-assistant",
        name: "assistant.delta",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "hello world",
      }),
      runtimeEvent({
        id: "event-completed",
        name: "turn.completed",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "done",
      }),
    ]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-output-cap-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run capped output task",
          "--non-interactive",
          "--json",
          "--max-output-bytes",
          "5",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const printed = JSON.parse(result.stdout) as {
        finalMessage?: string;
        output?: { finalMessageBytes?: number; truncated?: boolean; maxOutputBytes?: number | null };
      };
      expect(printed.finalMessage).toBe("hello");
      expect(printed.output).toEqual({
        finalMessageBytes: 5,
        truncated: true,
        maxOutputBytes: 5,
      });
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("event counters, turn id, and usage metadata reach CLI JSON output", async () => {
    const fake = await startCliHeadlessChatFakeServer([
      runtimeEvent({
        id: "event-assistant",
        name: "assistant.delta",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "Metadata ready.",
      }),
      runtimeEvent({
        id: "event-command",
        name: "command.output",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "pnpm test",
      }),
      runtimeEvent({
        id: "event-workspace",
        name: "workspace_action_result",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "saved",
      }),
      runtimeEvent({
        id: "event-usage",
        name: "session.context.updated",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        data: {
          provider: "openpond",
          model: "openpond-chat",
          usedTokens: 321,
          maxContextTokens: 128000,
          usableContextTokens: 117760,
          percentFull: 1,
          source: "provider_usage",
          updatedAtEventId: "event-usage",
        },
      }),
      runtimeEvent({
        id: "event-completed",
        name: "turn.completed",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "done",
      }),
    ]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-metadata-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run metadata task",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const printed = JSON.parse(result.stdout) as {
        finalMessage?: string;
        turnId?: string | null;
        events?: {
          terminal?: string;
          total?: number;
          commands?: number;
          workspaceActions?: number;
        };
        usage?: {
          provider?: string;
          model?: string;
          usedTokens?: number;
          source?: string;
          updatedAtEventId?: string;
        } | null;
      };
      expect(printed.finalMessage).toBe("Metadata ready.");
      expect(printed.turnId).toBe("turn-cli-headless");
      expect(printed.events).toMatchObject({
        terminal: "turn.completed",
        total: 5,
        commands: 1,
        workspaceActions: 1,
      });
      expect(printed.usage).toMatchObject({
        provider: "openpond",
        model: "openpond-chat",
        usedTokens: 321,
        source: "provider_usage",
        updatedAtEventId: "event-usage",
      });
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("one-shot timeout propagates exit 124 through the CLI wrapper", async () => {
    const fake = await startCliHeadlessChatFakeServer([]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-timeout-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run until CLI timeout",
          "--non-interactive",
          "--json",
          "--timeout-sec",
          "1",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(124);
      expect(result.stdout).toContain('"status": "timeout"');
      expect(result.stdout).toContain('"error": "Timed out after 1s during turn completion."');
      expect(result.stderr).toContain("exited with code 124");
      expect(fake.turnRequests).toHaveLength(1);
      expect(fake.interruptRequests).toBe(1);
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("failed terminal turns propagate exit 1 with JSON output", async () => {
    await expectCliHeadlessTerminalState({
      terminalEvent: runtimeEvent({
        id: "event-failed",
        name: "turn.failed",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "workspace command failed",
      }),
      expectedStatus: "failed",
      expectedError: "workspace command failed",
    });
  });

  test("interrupted terminal turns propagate exit 1 with JSON output", async () => {
    await expectCliHeadlessTerminalState({
      terminalEvent: runtimeEvent({
        id: "event-interrupted",
        name: "turn.interrupted",
        sessionId: "session-cli-headless",
        turnId: "turn-cli-headless",
        output: "interrupted by runtime",
      }),
      expectedStatus: "interrupted",
      expectedError: null,
    });
  });

  test("missing provider model exits 1 before posting a terminal turn", async () => {
    const fake = await startCliHeadlessChatFakeServer([], {
      bootstrapBody: bootstrapFixture(false),
    });
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-no-model-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--provider",
          "openai",
          "--message",
          "Run without a configured model",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exited with code 1");
      const printed = JSON.parse(result.stdout) as {
        status?: string;
        sessionId?: string | null;
        error?: string | null;
        events?: { terminal?: string };
      };
      expect(printed).toMatchObject({
        status: "failed",
        sessionId: "session-cli-headless",
        error: "No model selected for openai.",
        events: { terminal: "error" },
      });
      expect(fake.turnRequests).toHaveLength(0);
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("server bootstrap errors exit 1 before posting a terminal turn", async () => {
    const fake = await startCliHeadlessChatFakeServer([], {
      bootstrapStatus: 500,
      bootstrapBody: { error: "bootstrap unavailable" },
    });
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-server-error-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run while bootstrap fails",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exited with code 1");
      const printed = JSON.parse(result.stdout) as {
        status?: string;
        sessionId?: string | null;
        error?: string | null;
        events?: { terminal?: string };
      };
      expect(printed).toMatchObject({
        status: "failed",
        sessionId: null,
        error: "bootstrap unavailable",
        events: { terminal: "error" },
      });
      expect(fake.turnRequests).toHaveLength(0);
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("turn submission errors exit 1 after the failed request", async () => {
    const fake = await startCliHeadlessChatFakeServer([], {
      turnStatus: 500,
      turnBody: { error: "turn submission unavailable" },
    });
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-turn-error-"));
    const homeDir = path.join(tempRoot, "home");
    const taskDir = path.join(tempRoot, "task");
    await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run while turn submission fails",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: taskDir,
          env: {
            HOME: homeDir,
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exited with code 1");
      const printed = JSON.parse(result.stdout) as {
        status?: string;
        sessionId?: string | null;
        error?: string | null;
        events?: { terminal?: string };
      };
      expect(printed).toMatchObject({
        status: "failed",
        sessionId: "session-cli-headless",
        error: "turn submission unavailable",
        events: { terminal: "error" },
      });
      expect(fake.turnRequests).toHaveLength(1);
    } finally {
      fake.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("missing one-shot input propagates exit 2 through the CLI wrapper", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-usage-"));
    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: path.join(tempRoot, "home"),
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("requires --message, --message-file, or --stdin input");
      expect(result.stderr).toContain("exited with code 2");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("invalid one-shot option values exit 2 before launching the terminal child", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-bad-option-"));
    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--message",
          "Run this",
          "--non-interactive",
          "--json",
          "--timeout-sec",
          "0",
          "--no-server-start",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: path.join(tempRoot, "home"),
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("timeout-sec must be a positive integer");
      expect(result.stderr).not.toContain("exited with code");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("invalid one-shot trust values exit 2 before launching the terminal child", async () => {
    const cases = [
      {
        flag: "--sandbox",
        value: "uncontained",
        expectedError: "sandbox must be read-only, workspace-write, or danger-full-access",
      },
      {
        flag: "--approval-policy",
        value: "ask-every-time",
        expectedError: "approval-policy must be on-request, never, on-failure, or untrusted",
      },
    ];

    for (const testCase of cases) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-bad-trust-"));
      try {
        const result = await runProcessCommand(
          tsxBinary,
          [
            path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
            "chat",
            "--message",
            "Run this",
            "--non-interactive",
            "--json",
            testCase.flag,
            testCase.value,
            "--no-server-start",
          ],
          {
            cwd: tempRoot,
            env: {
              HOME: path.join(tempRoot, "home"),
            },
            timeoutMs: 5_000,
          },
        );

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(testCase.expectedError);
        expect(result.stderr).not.toContain("exited with code");
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  });

  test("ambiguous one-shot input sources exit 2 before server startup", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-ambiguous-input-"));
    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--message",
          "Run this from message",
          "--stdin",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: path.join(tempRoot, "home"),
          },
          stdin: "Run this from stdin\n",
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("accepts exactly one instruction source");
      expect(result.stderr).toContain("--message, --stdin");
      expect(result.stderr).toContain("exited with code 2");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("missing message-file input exits 2 before server startup", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-missing-file-"));
    try {
      const result = await runProcessCommand(
        tsxBinary,
        [
          path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
          "chat",
          "--message-file",
          "missing-instruction.md",
          "--non-interactive",
          "--json",
          "--no-server-start",
        ],
        {
          cwd: tempRoot,
          env: {
            HOME: path.join(tempRoot, "home"),
          },
          timeoutMs: 5_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("openpond chat --message-file could not read");
      expect(result.stderr).toContain("missing-instruction.md");
      expect(result.stderr).toContain("exited with code 2");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function expectCliHeadlessChat(
  entryArgs: string[],
  options: {
    command?: string;
    expectedPrompt: string;
    inputMode?: "message" | "message-file" | "stdin" | "implicit-stdin";
  },
): Promise<void> {
  const fake = await startCliHeadlessChatFakeServer([
    runtimeEvent({
      id: "event-assistant",
      name: "assistant.delta",
      sessionId: "session-cli-headless",
      turnId: "turn-cli-headless",
      output: "CLI task complete.",
    }),
    runtimeEvent({
      id: "event-completed",
      name: "turn.completed",
      sessionId: "session-cli-headless",
      turnId: "turn-cli-headless",
      output: "done",
    }),
  ]);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-cli-headless-"));
  const homeDir = path.join(tempRoot, "home");
  const taskDir = path.join(tempRoot, "task");
  await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");
  const expectedCwd = await realpath(taskDir);
  const inputMode = options.inputMode ?? "message";
  const instructionFileName = "instruction.md";
  if (inputMode === "message-file") {
    await writeFile(path.join(taskDir, instructionFileName), `${options.expectedPrompt}\n`, "utf8");
  }

  try {
    const inputArgs =
      inputMode === "message"
        ? ["--message", options.expectedPrompt]
        : inputMode === "message-file"
          ? ["--message-file", instructionFileName]
          : inputMode === "stdin"
            ? ["--stdin"]
            : [];
    const result = await runProcessCommand(
      options.command ?? (entryArgs[0]?.endsWith(".ts") ? tsxBinary : process.execPath),
      [
        ...entryArgs,
        "--server",
        fake.url,
        ...inputArgs,
        "--non-interactive",
        "--json",
        "--yes",
        "--no-server-start",
      ],
      {
        cwd: taskDir,
        env: {
          HOME: homeDir,
        },
        stdin: inputMode === "stdin" || inputMode === "implicit-stdin" ? `${options.expectedPrompt}\n` : undefined,
        timeoutMs: 10_000,
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const printed = JSON.parse(result.stdout) as { status?: string; finalMessage?: string; cwd?: string };
    expect(printed.status).toBe("completed");
    expect(printed.finalMessage).toBe("CLI task complete.");
    expect(printed.cwd).toBe(expectedCwd);
    expect(fake.turnRequests).toHaveLength(1);
    expect(fake.turnRequests[0]).toMatchObject({
      prompt: options.expectedPrompt,
      cwd: expectedCwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
  } finally {
    fake.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function expectCliHeadlessTerminalState(options: {
  terminalEvent: RuntimeEvent;
  expectedStatus: "failed" | "interrupted";
  expectedError: string | null;
}): Promise<void> {
  const fake = await startCliHeadlessChatFakeServer([
    runtimeEvent({
      id: "event-assistant-before-terminal",
      name: "assistant.delta",
      sessionId: "session-cli-headless",
      turnId: "turn-cli-headless",
      output: "Partial result.",
    }),
    options.terminalEvent,
  ]);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `openpond-cli-headless-${options.expectedStatus}-`));
  const homeDir = path.join(tempRoot, "home");
  const taskDir = path.join(tempRoot, "task");
  await mkdir(path.join(homeDir, ".openpond", "openpond-app"), { recursive: true });
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(homeDir, ".openpond", "openpond-app", "token"), "test-token\n", "utf8");

  try {
    const result = await runProcessCommand(
      tsxBinary,
      [
        path.join(REPO_ROOT, "apps", "cli", "src", "cli", "main.ts"),
        "chat",
        "--server",
        fake.url,
        "--message",
        `Trigger ${options.expectedStatus}`,
        "--non-interactive",
        "--json",
        "--no-server-start",
      ],
      {
        cwd: taskDir,
        env: {
          HOME: homeDir,
        },
        timeoutMs: 5_000,
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exited with code 1");
    const printed = JSON.parse(result.stdout) as {
      status?: string;
      finalMessage?: string;
      error?: string | null;
      events?: { terminal?: string };
    };
    expect(printed.status).toBe(options.expectedStatus);
    expect(printed.finalMessage).toBe("Partial result.");
    expect(printed.error).toBe(options.expectedError);
    expect(printed.events?.terminal).toBe(options.terminalEvent.name);
    expect(fake.turnRequests).toHaveLength(1);
  } finally {
    fake.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function runtimeEvent(input: Partial<RuntimeEvent> & Pick<RuntimeEvent, "id" | "name">): RuntimeEvent {
  return {
    timestamp: "2026-07-06T00:00:00.000Z",
    ...input,
  } as RuntimeEvent;
}

async function startCliHeadlessChatFakeServer(
  events: RuntimeEvent[],
  options: {
    bootstrapStatus?: number;
    bootstrapBody?: Record<string, unknown>;
    turnStatus?: number;
    turnBody?: Record<string, unknown>;
  } = {},
): Promise<{
  url: string;
  turnRequests: Record<string, unknown>[];
  interruptRequests: number;
  stop: () => void;
}> {
  const encoder = new TextEncoder();
  const eventControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const queuedFrames: string[] = [];
  const turnRequests: Record<string, unknown>[] = [];
  let interruptRequests = 0;
  const now = "2026-07-06T00:00:00.000Z";

  function enqueueFrame(frame: string): void {
    if (eventControllers.size === 0) {
      queuedFrames.push(frame);
      return;
    }
    for (const controller of eventControllers) {
      controller.enqueue(encoder.encode(frame));
    }
  }

  const server = await startFetchTestServer(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/v1/bootstrap") {
        return Response.json(options.bootstrapBody ?? bootstrapFixture(), {
          status: options.bootstrapStatus ?? 200,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        return Response.json({
          id: "session-cli-headless",
          provider: body.provider ?? "openpond",
          modelRef: body.modelRef ?? null,
          openPondCommandAccessMode: "ask",
          title: body.title ?? "Terminal chat",
          appId: body.appId ?? null,
          appName: body.appName ?? null,
          cwd: body.cwd ?? null,
          codexThreadId: null,
          createdAt: now,
          updatedAt: now,
          status: "idle",
          pinned: false,
          archived: false,
          order: 0,
        });
      }
      if (url.pathname === "/v1/events") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              eventControllers.add(controller);
              controller.enqueue(encoder.encode('event: ready\ndata: {"ok": true}\n\n'));
              for (const frame of queuedFrames.splice(0)) controller.enqueue(encoder.encode(frame));
            },
            cancel() {
              eventControllers.clear();
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/session-cli-headless/turns") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        turnRequests.push(body);
        if (options.turnStatus && options.turnStatus >= 400) {
          return Response.json(options.turnBody ?? { error: "turn failed" }, { status: options.turnStatus });
        }
        queueMicrotask(() => {
          for (const event of events) enqueueFrame(`data: ${JSON.stringify(event)}\n\n`);
        });
        return Response.json({ id: "turn-cli-headless" }, { status: 202 });
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/session-cli-headless/turns/interrupt") {
        interruptRequests += 1;
        return Response.json({ ok: true }, { status: 202 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
  });

  return {
    url: server.url,
    turnRequests,
    get interruptRequests() {
      return interruptRequests;
    },
    stop: () => server.stop(),
  };
}

function bootstrapFixture(withDefaultModel = true): Record<string, unknown> {
  return {
    providers: {
      version: 1,
      providers: withDefaultModel
        ? {
            openai: {
              enabled: true,
              defaultModel: "gpt-5.6-sol",
            },
          }
        : {},
      statuses: {},
      modelCaches: {},
    },
    profile: {
      mode: "local",
      activeProfile: "default",
      summary: { state: "ready" },
    },
    sessions: [],
    codexHistorySessions: [],
    approvals: [],
    localProjects: [],
    cloudProjects: [],
    apps: [],
  };
}
