import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { Logger } from "@openpond/logging";
import { userBunBinPath } from "./desktop-executable-path-bun-compat.js";

const pathMarker = "__OPENPOND_EXECUTABLE_PATH__";

function loginShell(env: NodeJS.ProcessEnv): string {
  if (env.SHELL && path.isAbsolute(env.SHELL)) return env.SHELL;
  try {
    const shell = userInfo().shell;
    if (shell && path.isAbsolute(shell)) return shell;
  } catch { /* Some desktop sessions have no passwd entry. */ }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

async function shellPath(env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  // Interactive login shells load both profile and rc files (including nvm).
  // Import only PATH, never credentials or other shell environment variables.
  return new Promise((resolve) => {
    const child = execFile(loginShell(env), ["-ilc", `printf '${pathMarker}'; /usr/bin/printenv PATH; printf '\\0'`], {
      env, timeout, maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) { resolve(""); return; }
      const start = stdout.lastIndexOf(pathMarker);
      const end = stdout.indexOf("\0", start);
      resolve(start >= 0 && end > start ? stdout.slice(start + pathMarker.length, end).replace(/\r?\n$/, "") : "");
    });
    child.stdin?.end();
  });
}

function installationPaths(home: string, env: NodeJS.ProcessEnv): string[] {
  const directories = [
    path.join(home, ".local", "bin"), path.join(home, "bin"),
    userBunBinPath(home, env),
    path.join(home, ".npm-global", "bin"), path.join(home, ".npm", "bin"),
    path.join(home, ".grok", "bin"), path.join(home, ".opencode", "bin"),
    env.PNPM_HOME || path.join(home, ".local", "share", "pnpm"),
  ];
  directories.push(
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    "/Applications/Codex.app/Contents/Resources",
    path.join(env.VOLTA_HOME || path.join(home, ".volta"), "bin"),
    path.join(env.ASDF_DATA_DIR || path.join(home, ".asdf"), "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
  );
  // Retain access to Node-based CLI launchers if shell startup fails or times
  // out. A successfully recovered shell's selected version takes precedence.
  const nvmRoot = path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node");
  try {
    const versions = readdirSync(nvmRoot).filter((version) => /^v\d+\.\d+\.\d+$/.test(version));
    versions.sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
    directories.push(...versions.map((version) => path.join(nvmRoot, version, "bin")));
  } catch { /* nvm is optional. */ }
  // Keep installer destinations even before they exist: providers can be
  // installed while the desktop app and its server are already running.
  return directories.filter((directory) => path.isAbsolute(directory));
}

/** Desktop launchers can omit the shell's installed tools and their runtimes. */
export async function resolveDesktopExecutablePath(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  shellTimeoutMs?: number;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const inherited = env.PATH ?? "";
  const recovered = await shellPath(env, options.shellTimeoutMs ?? 5_000);
  const entries = [recovered, inherited, ...installationPaths(options.home ?? homedir(), env)]
    .flatMap((entry) => entry.split(path.delimiter))
    .filter((entry) => path.isAbsolute(entry));
  return [...new Set(entries)].join(path.delimiter);
}

let executablePathReady: Promise<void> | null = null;

export async function initializeDesktopExecutablePath(logger: Logger): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  await (executablePathReady ??= resolveDesktopExecutablePath().then((searchPath) => {
    process.env.PATH = searchPath;
    logger.info("desktop executable search path", { path: searchPath });
  }));
}
