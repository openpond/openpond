import { runProcessCommand, type ProcessCommandResult } from "../../process-runner";

export type CommandResult = ProcessCommandResult;

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    inherit?: boolean;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {}
): Promise<CommandResult> {
  return runProcessCommand(command, args, {
    cwd: options.cwd,
    inherit: options.inherit,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

export async function runShellCommand(
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    maxOutputBytes?: number;
    inherit?: boolean;
  } = {}
): Promise<CommandResult & { timedOut: boolean }> {
  const timeoutMs =
    options.timeoutSeconds === undefined
      ? undefined
      : options.timeoutSeconds * 1000;
  return runProcessCommand(command, [], {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    inherit: options.inherit,
    timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

export async function getGitRemoteUrl(
  cwd: string,
  remoteName: string
): Promise<string | null> {
  const result = await runCommand("git", ["remote", "get-url", remoteName], {
    cwd,
  });
  if (result.code !== 0) return null;
  const url = result.stdout.trim();
  return url.length > 0 ? url : null;
}
