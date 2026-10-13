import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { executableInstallationPaths } from "./executable-installation-paths.js";

const marker = "__OPENPOND_EXECUTABLE_PATH__";

export function executableSearchPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (process.platform === "win32") return env.PATH ?? env.Path ?? "";
  return mergePaths([env.PATH ?? "", ...executableInstallationPaths(env, home)]);
}

function mergePaths(values: string[]): string {
  return [...new Set(values.flatMap(value => value.split(path.delimiter)).filter(value => path.isAbsolute(value) && !/[\r\n\0]/u.test(value)))].join(path.delimiter);
}

/** Resolve executable files directly; never rely on an external `which` or a shell. */
export function findLocalExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform === "win32") return null;
  const candidates = path.isAbsolute(command) ? [command]
    : (env.PATH ?? "").split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* Missing, broken symlinks and non-executable files are not launchers. */ }
  }
  return null;
}

function loginShellCandidates(env: NodeJS.ProcessEnv): string[] {
  let userShell: string | undefined;
  try { userShell = userInfo().shell ?? undefined; } catch { /* GUI sessions can omit passwd information. */ }
  return [...new Set([
    env.SHELL, userShell,
    ...(process.platform === "darwin" ? ["/bin/zsh", "/bin/bash"] : ["/bin/bash", "/bin/zsh"]),
    "/usr/bin/fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish",
  ].filter((shell): shell is string => Boolean(shell && path.isAbsolute(shell))))];
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise(resolve => {
    const child = execFile(command, args, { env, timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
    child.stdin?.end();
  });
}

async function readShellPath(shell: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  // Only import PATH. Shell configuration can contain credentials and must
  // never be copied wholesale into the server's environment or diagnostics.
  const output = await capture(shell, ["-ilc", `printf '${marker}'; /usr/bin/printenv PATH; printf '\\0'`], env, timeout);
  const start = output.lastIndexOf(marker);
  const end = output.indexOf("\0", start);
  return start >= 0 && end > start ? output.slice(start + marker.length, end).replace(/\r?\n$/, "") : "";
}

export async function resolveLocalExecutablePath(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  shellTimeoutMs?: number;
  shellCandidates?: readonly string[];
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  if (process.platform === "win32") return env.PATH ?? env.Path ?? "";
  const timeout = options.shellTimeoutMs ?? 5_000;
  const candidates = options.shellCandidates ?? loginShellCandidates(env);
  let recovered = candidates[0] ? await readShellPath(candidates[0], env, Math.max(1, Math.ceil(timeout))) : "";
  if (!recovered) {
    // Alternate shells are independent. Bound recovery to one additional
    // deadline instead of serially waiting for every broken startup file.
    const fallback = await Promise.all(candidates.slice(1).map(shell => readShellPath(shell, env, Math.max(1, Math.ceil(timeout)))));
    recovered = fallback.find(Boolean) ?? "";
  }
  const launchctl = !recovered && process.platform === "darwin"
    ? (await capture("/bin/launchctl", ["getenv", "PATH"], env, 2_000)).trim() : "";
  return mergePaths([recovered, launchctl, executableSearchPath(env, options.home ?? homedir())]);
}

let refreshedAt = 0;
let refreshing: Promise<void> | null = null;
/** Re-probe at connection checks; an installed CLI or changed shell path needs no restart. */
export async function refreshLocalExecutablePath(force = false): Promise<void> {
  if (process.platform === "win32") return;
  if (refreshing) return refreshing;
  if (!force && Date.now() - refreshedAt < 30_000) return;
  refreshing = resolveLocalExecutablePath().then(searchPath => {
    process.env.PATH = searchPath;
    refreshedAt = Date.now();
  }).finally(() => { refreshing = null; });
  return refreshing;
}
