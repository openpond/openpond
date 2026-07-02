import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, promises as fs } from "node:fs";
import path from "node:path";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};
export const MACOS_GIT_MISSING_DEVELOPER_TOOLS_ERROR =
  "Git is required for OpenPond app workspaces, but macOS reports Apple Command Line Tools are not installed. " +
  "OpenPond skipped /usr/bin/git to avoid opening the Xcode installer prompt. Install Command Line Tools with " +
  "`xcode-select --install`, install Git from Homebrew, or put a non-Apple git binary earlier on PATH.";

let resolvedGitCommand: string | undefined;
function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstNonAppleGitOnPath(): string | null {
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "git");
    if (candidate === "/usr/bin/git" || candidate === "/bin/git") continue;
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function appleDeveloperToolsAvailable(): boolean {
  const result = spawnSync("/usr/bin/xcode-select", ["-p"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function resolveWorkspaceCommand(command: string): { command: string } | { error: string } {
  if (command !== "git" || process.platform !== "darwin") return { command };
  if (resolvedGitCommand !== undefined) {
    return { command: resolvedGitCommand };
  }

  const nonAppleGit = firstNonAppleGitOnPath();
  if (nonAppleGit) {
    resolvedGitCommand = nonAppleGit;
    return { command: nonAppleGit };
  }

  if (appleDeveloperToolsAvailable()) {
    resolvedGitCommand = "git";
    return { command: "git" };
  }

  return { error: MACOS_GIT_MISSING_DEVELOPER_TOOLS_ERROR };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const resolved = resolveWorkspaceCommand(command);
    if ("error" in resolved) {
      resolve({ code: 1, stdout: "", stderr: resolved.error });
      return;
    }
    const child = spawn(resolved.command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

export { runCommand as runWorkspaceCommand };

export function isMacOSGitDeveloperToolsMissing(value: string | null | undefined): boolean {
  return Boolean(value && value.includes(MACOS_GIT_MISSING_DEVELOPER_TOOLS_ERROR.slice(0, 80)));
}

export async function checkWorkspaceGitAvailability(cwd: string): Promise<
  | { ok: true; command: string; version: string }
  | { ok: false; error: string; installAction: "macos_command_line_tools" | "manual_git_install" }
> {
  await fs.mkdir(cwd, { recursive: true });
  const result = await runCommand("git", ["--version"], cwd);
  if (result.code === 0) {
    return {
      ok: true,
      command: resolvedGitCommand ?? "git",
      version: (result.stdout || result.stderr).trim(),
    };
  }
  const error = result.stderr.trim() || result.stdout.trim() || "Git is required for OpenPond app workspaces.";
  return {
    ok: false,
    error,
    installAction:
      process.platform === "darwin" && isMacOSGitDeveloperToolsMissing(error)
        ? "macos_command_line_tools"
        : "manual_git_install",
  };
}

export function startMacOSCommandLineToolsInstall(): { ok: true; message: string } | { ok: false; error: string } {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Apple Command Line Tools installation is only available on macOS." };
  }
  if (appleDeveloperToolsAvailable()) {
    return { ok: true, message: "Apple Command Line Tools already appear to be installed." };
  }
  try {
    const child = spawn("/usr/bin/xcode-select", ["--install"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, message: "Opened the Apple Command Line Tools installer." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
