import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliUsageError, optionValues, parseArgs, runCommand, runShellCommand } from "../src/cli/common";

describe("CLI common parsing", () => {
  test("parses equals-style long options without changing rest arguments", () => {
    const parsed = parseArgs([
      "profile",
      "load",
      "--path=/tmp/openpond-profile",
      "--profile",
      "default",
      "--json",
    ]);

    expect(parsed.command).toBe("profile");
    expect(parsed.rest).toEqual(["load"]);
    expect(parsed.options.path).toBe("/tmp/openpond-profile");
    expect(parsed.options.profile).toBe("default");
    expect(parsed.options.json).toBe("true");
  });

  test("keeps passthrough arguments after double dash", () => {
    const parsed = parseArgs([
      "run",
      "chat",
      "--json",
      "--",
      "--input",
      "{\"prompt\":\"hello\"}",
    ]);

    expect(parsed.command).toBe("run");
    expect(parsed.options.json).toBe("true");
    expect(parsed.rest).toEqual(["chat", "--input", "{\"prompt\":\"hello\"}"]);
  });

  test("rejects unknown and cross-command options before passthrough", () => {
    expect(() => parseArgs(["chat", "--definitely-unknown", "value"])).toThrow(
      "unknown option --definitely-unknown for chat",
    );
    expect(() => parseArgs(["chat", "--team-id", "team_1"])).toThrow(
      "unknown option --team-id for chat",
    );

    const passthrough = parseArgs(["chat", "--", "--definitely-unknown", "value"]);
    expect(passthrough.rest).toEqual(["--definitely-unknown", "value"]);
  });

  test("records repeated option values while preserving last-value compatibility", () => {
    const parsed = parseArgs([
      "sandbox-template",
      "start",
      "--input-file",
      "fixture=a.json",
      "--input-file=fixture=b.json",
      "--input-file",
      "fixture=c.json",
    ]);

    expect(parsed.command).toBe("sandbox-template");
    expect(parsed.rest).toEqual(["start"]);
    expect(parsed.options.inputFile).toBe("fixture=c.json");
    expect(optionValues(parsed.options, "inputFile")).toEqual([
      "fixture=a.json",
      "fixture=b.json",
      "fixture=c.json",
    ]);
  });

  test("expands useful short aliases without swallowing positional arguments", () => {
    const parsed = parseArgs([
      "-j",
      "-C",
      "/tmp/openpond-workspace",
      "profile",
      "current",
      "--json",
      "default",
    ]);

    expect(parsed.command).toBe("profile");
    expect(parsed.rest).toEqual(["current", "default"]);
    expect(parsed.options.json).toBe("true");
    expect(parsed.options.cwd).toBe("/tmp/openpond-workspace");
    expect(optionValues(parsed.options, "json")).toEqual(["true", "true"]);
  });

  test("supports clustered boolean short aliases", () => {
    const parsed = parseArgs(["sandbox-template", "push", "-fy"]);

    expect(parsed.command).toBe("sandbox-template");
    expect(parsed.rest).toEqual(["push"]);
    expect(parsed.options.force).toBe("true");
    expect(parsed.options.yes).toBe("true");
  });

  test("validates typed option values during parsing", () => {
    expect(() => parseArgs(["sandbox", "ps", "--timeout-seconds=soon"])).toThrow(
      /timeout-seconds must be an integer/,
    );
    expect(() => parseArgs(["chat", "--timeout-sec=0"])).toThrow(
      /timeout-sec must be a positive integer/,
    );
    expect(() => parseArgs(["chat", "--max-output-bytes=-1"])).toThrow(
      /max-output-bytes must be a positive integer/,
    );
    expect(() => parseArgs(["profile", "current", "--json=maybe"])).toThrow(
      /json must be a boolean/,
    );
    expect(() => parseArgs(["run", "chat", "--cwd"])).toThrow(
      /cwd must be a string/,
    );
  });

  test("marks typed option parse failures as usage errors", () => {
    try {
      parseArgs(["chat", "--timeout-sec=soon"]);
      throw new Error("expected parseArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as { exitCode?: number }).exitCode).toBe(2);
      expect(error).toHaveProperty("message", "timeout-sec must be an integer");
    }
    try {
      parseArgs(["chat", "--max-output-bytes=0"]);
      throw new Error("expected parseArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as { exitCode?: number }).exitCode).toBe(2);
      expect(error).toHaveProperty("message", "max-output-bytes must be a positive integer");
    }
  });

  test("leaves command-specific text options permissive", () => {
    const parsed = parseArgs(["sandbox", "pty-write", "sandbox-1", "pty-1", "--input", "ls -la"]);

    expect(parsed.command).toBe("sandbox");
    expect(parsed.rest).toEqual(["pty-write", "sandbox-1", "pty-1"]);
    expect(parsed.options.input).toBe("ls -la");
  });

  test("parses profile hosted promotion options with typed JSON input", () => {
    const parsed = parseArgs([
      "profile",
      "push",
      "--team-id",
      "team_1",
      "--hosted-source-checks",
      "--publish-hosted-source",
      "--hosted-source-agent-id",
      "agent_1",
      "--hosted-source-dispatch",
      "coding_core",
      "--hosted-run-input",
      '{"prompt":"hello"}',
      "--hosted-run-retry",
      "--hosted-run-idempotency-key",
      "retry-key-1",
      "--hosted-run-conversation-id",
      "session_hosted_1",
      "--hosted-run-target-project-id",
      "workspace_project_1",
      "--conversation-id",
      "session_alias_1",
    ]);

    expect(parsed.command).toBe("profile");
    expect(parsed.rest).toEqual(["push"]);
    expect(parsed.options.hostedSourceChecks).toBe("true");
    expect(parsed.options.publishHostedSource).toBe("true");
    expect(parsed.options.hostedSourceAgentId).toBe("agent_1");
    expect(parsed.options.hostedSourceDispatch).toBe("coding_core");
    expect(parsed.options.hostedRunInput).toBe('{"prompt":"hello"}');
    expect(parsed.options.hostedRunRetry).toBe("true");
    expect(parsed.options.hostedRunIdempotencyKey).toBe("retry-key-1");
    expect(parsed.options.hostedRunConversationId).toBe("session_hosted_1");
    expect(parsed.options.hostedRunTargetProjectId).toBe("workspace_project_1");
    expect(parsed.options.conversationId).toBe("session_alias_1");
  });
});

describe("CLI common process runner", () => {
  test("caps captured command output and reports truncation", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "console.log('x'.repeat(80))"],
      { maxOutputBytes: 24 }
    );

    expect(result.code).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain("[truncated after 24 bytes]");
    expect(result.stdout.length).toBeLessThan(80);
  });

  test("runs shell commands through the shared runner with merged env", async () => {
    const result = await runShellCommand(
      `${process.execPath} -e "console.log(process.env.OPENPOND_RUNNER_TEST)"`,
      { env: { OPENPOND_RUNNER_TEST: "shell-ok" } }
    );

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("shell-ok");
  });

  test("terminates commands that exceed the configured timeout", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "await new Promise((resolve) => setTimeout(resolve, 1000));"],
      { timeoutMs: 50 }
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.terminationReason).toBe("timeout");
  });

  test("reports signal exits separately from normal exit codes", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
    );

    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.terminationReason).toBe("signal");
  });

  const posixTest = process.platform === "win32" ? test.skip : test;
  posixTest("terminates descendants in the timed-out process group", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-process-tree-"));
    const pidFile = path.join(directory, "child.pid");
    try {
      const script = [
        "const {spawn}=require('node:child_process');",
        `spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)}],{stdio:'ignore'});`,
        "setInterval(()=>{},1000);",
      ].join("");
      const result = await runCommand(process.execPath, ["-e", script], { timeoutMs: 300 });
      const childPid = Number(await readFile(pidFile, "utf8"));

      expect(result.terminationReason).toBe("timeout");
      expect(await waitForProcessExit(childPid)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
