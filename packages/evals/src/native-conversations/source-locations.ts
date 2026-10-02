import { opendir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface SourceLocation { root: string; reason?: string }

export function hermesHome(home: string, env: NodeJS.ProcessEnv) {
  const configured = env.HERMES_HOME?.trim();
  if (configured) {
    const expanded = configured.replace(/\$(\w+)|\$\{([^}]+)\}/gu, (match, bare: string, braced: string) =>
      env[bare || braced] ?? match);
    return resolve(expanded === "~" ? home : expanded.startsWith("~/") ? join(home, expanded.slice(2)) : expanded);
  }
  const suffix = env.HERMES_DATA_DIR_SUFFIX || "";
  return process.platform === "win32"
    ? join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), `hermes${suffix}`)
    : join(home, `.hermes${suffix}`);
}

const isDirectory = (path: string) => stat(path).then((s) => s.isDirectory()).catch(() => false);
const isFile = (path: string) => stat(path).then((s) => s.isFile()).catch(() => false);

/** A bounded metadata-only inventory. No profile config or credential files are read. */
async function profileNames(root: string, valid: (name: string) => boolean) {
  const names: string[] = [];
  const directory = await opendir(root).catch(() => null);
  if (!directory) return names;
  let entries = 0;
  for await (const entry of directory) {
    if (++entries > 100) throw new Error("More than 100 profile entries. Select the exact --source-path.");
    if (entry.isDirectory() && !entry.isSymbolicLink() && valid(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

export async function hermesLocations(root: string): Promise<SourceLocation[]> {
  // A launcher may already have selected a named profile. Never enumerate its siblings.
  if (basename(dirname(root)) === "profiles") return [{ root }];
  const profiles = join(root, "profiles");
  try {
    const names = await profileNames(profiles, (name) => /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name));
    const locations: SourceLocation[] = [];
    // Retained state.db is the only identity marker relevant to this history reader.
    // Deleted profiles are deliberately excluded, even if their old DB remains.
    for (const name of names) {
      if (await stat(join(profiles, ".deleted", name)).then(() => true).catch(() => false)) continue;
      if (await isFile(join(profiles, name, "state.db"))) locations.push({ root: join(profiles, name) });
    }
    let active = "";
    const activeFile = join(root, "active_profile");
    if (await stat(activeFile).then((s) => s.isFile() && s.size <= 1024).catch(() => false))
      active = (await readFile(activeFile, "utf8")).replace(/^\uFEFF/u, "").trim().toLowerCase();
    if (active && active !== "default") {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(active))
        return [{ root, reason: "Hermes active profile is invalid. Select the exact --source-path." }];
      const selected = locations.findIndex((location) => location.root === join(profiles, active));
      if (selected < 0) locations.unshift({ root: join(profiles, active), reason: "Hermes active profile has no retained live state database. Select a profile explicitly." });
      else locations.unshift(...locations.splice(selected, 1));
    }
    if (await isFile(join(root, "state.db")) || !locations.length) locations.push({ root });
    return locations;
  } catch (error) {
    return [{ root, reason: error instanceof Error ? error.message : "Cannot inventory Hermes profiles. Select the exact --source-path." }];
  }
}

function validOmpProfile(name: string) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name) && !name.endsWith(".") &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name);
}

export async function ompLocations(home: string, env: NodeJS.ProcessEnv): Promise<SourceLocation[]> {
  const base = join(home, env.PI_CONFIG_DIR || ".omp");
  const selected = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (selected && selected !== "default" && !validOmpProfile(selected))
    return [{ root: base, reason: "Oh My Pi profile is invalid. Select the exact --source-path." }];
  // Launch-time session override has higher priority than the agent directory.
  if (env.PI_CODING_AGENT_SESSION_DIR) return [{ root: resolve(env.PI_CODING_AGENT_SESSION_DIR) }];
  const xdg = (process.platform === "linux" || process.platform === "darwin") && env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, "omp") : undefined;
  async function location(profile?: string): Promise<SourceLocation> {
    const standard = profile ? join(base, "profiles", profile, "agent") : join(base, "agent");
    // Named profiles ignore the default-profile agent override. A native launch
    // may export its own profile-derived value; explicit empty OMP_PROFILE clears it.
    const inheritedProfile = env.PI_PROFILE?.trim();
    const inherited = inheritedProfile && validOmpProfile(inheritedProfile)
      ? join(base, "profiles", inheritedProfile, "agent") : undefined;
    const override = !profile && env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR !== inherited
      ? resolve(env.PI_CODING_AGENT_DIR) : undefined;
    const candidate = xdg && (profile ? join(xdg, "profiles", profile) : xdg);
    return { root: (!override || override === standard) && candidate && await isDirectory(candidate) ? candidate : override || standard };
  }
  if (selected || env.OMP_PROFILE !== undefined || env.PI_PROFILE !== undefined || env.PI_CODING_AGENT_DIR)
    return [await location(selected && selected !== "default" ? selected : undefined)];
  try {
    const names = new Set(await profileNames(join(base, "profiles"), validOmpProfile));
    if (xdg) for (const name of await profileNames(join(xdg, "profiles"), validOmpProfile)) names.add(name);
    const result = [await location()];
    for (const name of [...names].sort()) {
      const candidate = await location(name);
      if (await isDirectory(join(candidate.root, "sessions"))) result.push(candidate);
    }
    return result;
  } catch (error) {
    return [{ root: base, reason: error instanceof Error ? error.message : "Cannot inventory Oh My Pi profiles. Select the exact --source-path." }];
  }
}
