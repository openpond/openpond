import { format } from "node:util";
import { vi } from "vitest";
import { runCliCommand } from "../src/cli/command-registry";
import { parseArgs } from "../src/cli/common/args";

// Exercise real parsing, dispatch, and HTTP contracts without starting tsx for
// every command. Stdin, process exit, and packed installation have separate proofs.
// These suites run in isolated forks and must not use concurrent test cases.
export async function runCommand(args: string[], stdin = "", options: { cwd?: string } = {}) {
  if (stdin) throw new Error("Use runCli for a real stdin boundary");
  const cwd = process.cwd();
  const previousKey = process.env.OPENPOND_API_KEY;
  const previousExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";
  const log = vi.spyOn(console, "log").mockImplementation((...values) => { stdout += `${format(...values)}\n`; });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => { stderr += `${format(...values)}\n`; });
  try {
    process.env.OPENPOND_API_KEY = "opk_test_cli";
    process.exitCode = 0;
    if (options.cwd) process.chdir(options.cwd);
    const handled = await runCliCommand(parseArgs(args));
    if (!handled) throw new Error(`Unhandled fixture command: ${args[0]}`);
    return { code: Number(process.exitCode ?? 0), stdout, stderr };
  } catch (failure) {
    stderr += `${failure instanceof Error ? failure.message : String(failure)}\n`;
    return { code: 1, stdout, stderr };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.chdir(cwd);
    if (previousKey === undefined) delete process.env.OPENPOND_API_KEY;
    else process.env.OPENPOND_API_KEY = previousKey;
    process.exitCode = previousExitCode;
  }
}
