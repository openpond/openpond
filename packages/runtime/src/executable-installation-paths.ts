import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { userCliBinPath } from "./executable-installation-bun-compat.js";

// Search only installer-owned roots, never recursively crawl the user's home.
function versions(root: string, suffix: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .slice(0, 64)
      .map(version => path.join(root, version, suffix));
  } catch { return []; }
}

function npmUserPrefix(env: NodeJS.ProcessEnv, home: string): string | null {
  const file = env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || path.join(home, ".npmrc");
  try {
    if (statSync(file).size > 64 * 1024) return null;
    const match = /^\s*prefix\s*=\s*(.*?)\s*$/mi.exec(readFileSync(file, "utf8"));
    if (!match?.[1]) return null;
    const value = match[1].replace(/^['"]|['"]$/g, "").replace(/\$\{([^}]+)\}/g, (_match, name: string) => env[name] ?? "");
    const expanded = value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
    return path.isAbsolute(expanded) ? expanded : null;
  } catch { return null; }
}

export function executableInstallationPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (process.platform === "win32") return [];
  const xdgData = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const mise = env.MISE_DATA_DIR || path.join(xdgData, "mise");
  const asdf = env.ASDF_DATA_DIR || path.join(home, ".asdf");
  const fnm = [env.FNM_DIR, path.join(home, ".fnm"), path.join(xdgData, "fnm"), path.join(home, "Library", "Application Support", "fnm")].filter((value): value is string => Boolean(value));
  const npmPrefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || npmUserPrefix(env, home);
  return [
    path.join(home, ".local", "bin"), path.join(home, "bin"), userCliBinPath(home, env),
    ...(npmPrefix ? [path.join(npmPrefix, "bin")] : []),
    path.join(home, ".npm-global", "bin"), path.join(home, ".npm", "bin"),
    path.join(home, ".npm-packages", "bin"),
    env.PNPM_HOME || path.join(xdgData, "pnpm"), path.join(home, "Library", "pnpm"),
    path.join(home, ".grok", "bin"), path.join(home, ".opencode", "bin"),
    path.join(home, ".claude", "local", "node_modules", ".bin"), path.join(home, ".claude", "local"),
    ...(env.FNM_MULTISHELL_PATH ? [path.join(env.FNM_MULTISHELL_PATH, "bin")] : []),
    ...(env.HOMEBREW_PREFIX ? [path.join(env.HOMEBREW_PREFIX, "bin")] : []),
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/home/linuxbrew/.linuxbrew/bin",
    path.join(home, ".linuxbrew", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/snap/bin",
    path.join(home, ".nix-profile", "bin"), "/nix/var/nix/profiles/default/bin", "/run/current-system/sw/bin",
    path.join(env.VOLTA_HOME || path.join(home, ".volta"), "bin"),
    path.join(asdf, "shims"), path.join(mise, "shims"), path.join(xdgConfig, "mise", "shims"),
    path.join(env.NODENV_ROOT || path.join(home, ".nodenv"), "shims"),
    "/Applications/Codex.app/Contents/Resources", path.join(home, "Applications", "Codex.app", "Contents", "Resources"),
    ...versions(path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node"), "bin"),
    ...versions(path.join(xdgConfig, "nvm", "versions", "node"), "bin"),
    ...fnm.flatMap(root => versions(path.join(root, "node-versions"), path.join("installation", "bin"))),
    ...versions(path.join(mise, "installs", "node"), "bin"),
    ...["claude", "claude-code", "grok", "opencode"].flatMap(tool => [
      ...versions(path.join(mise, "installs", tool), "bin"),
      ...versions(path.join(mise, "installs", tool), ""),
      ...versions(path.join(asdf, "installs", tool), "bin"),
    ]),
    ...versions(path.join(asdf, "installs", "nodejs"), "bin"),
    ...versions(path.join(env.NODENV_ROOT || path.join(home, ".nodenv"), "versions"), "bin"),
    ...versions(path.join(env.N_PREFIX || path.join(home, "n"), "n", "versions", "node"), "bin"),
    ...versions("/usr/local/n/versions/node", "bin"),
  ].filter(directory => path.isAbsolute(directory));
}
