import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { prepareAgentSdkRuntimePackage } from "@openpond/cloud";

const execFileAsync = promisify(execFile);
type PackageManager = "npm" | "pnpm";

/** Install only the exact production graph authored with the released Agent.
 * Lifecycle scripts are disabled; execution of Agent code happens separately
 * under the ordinary workflow permissions. */
export async function prepareReleasedProfileActionDependencies(input: {
  runPath: string;
  install?: (manager: PackageManager, args: string[], cwd: string) => Promise<void>;
}): Promise<void> {
  const manifestPath = path.join(input.runPath, "package.json");
  const manifestStat = await fs.lstat(manifestPath).catch(() => null);
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) {
    throw new Error("Released Profile Agent package manifest must be a regular file.");
  }
  if (!manifestStat) await fs.writeFile(manifestPath, '{"type":"module"}\n', { flag: "wx" });
  const manager = await inspectReleasedProfileActionDependencies(input.runPath);
  if (manager) {
    const args = manager === "npm"
      ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"];
    await (input.install ?? installLockedDependencies)(manager, args, input.runPath);
  }
  const sdkPath = path.join(input.runPath, "node_modules", "openpond-agent-sdk");
  if (!(await fs.lstat(sdkPath).catch(() => null))) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const dependencies = { ...dependencyMap(manifest.dependencies), ...dependencyMap(manifest.optionalDependencies) };
    if (dependencies["openpond-agent-sdk"]) {
      throw new Error("Released Profile Agent declared an SDK dependency that the locked installation did not provide.");
    }
    const sdkRoot = await prepareAgentSdkRuntimePackage();
    await fs.mkdir(path.dirname(sdkPath), { recursive: true });
    await fs.symlink(sdkRoot, sdkPath, "dir");
  }
}

/** Validate the release boundary before an Agent is admitted. The lock must
 * travel beside the Agent manifest in its published Profile source. */
export async function inspectReleasedProfileActionDependencies(runPath: string): Promise<PackageManager | null> {
  const manifestPath = path.join(runPath, "package.json");
  const manifestStat = await fs.lstat(manifestPath).catch(() => null);
  if (!manifestStat) return null;
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Released Profile Agent package manifest must be a regular file.");
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const dependencies = { ...dependencyMap(manifest.dependencies), ...dependencyMap(manifest.optionalDependencies) };
  if (Object.keys(dependencies).length) {
    for (const [name, spec] of Object.entries(dependencies)) {
      if (/^(?:file:|link:|workspace:|git\+|https?:)/i.test(spec)) {
        throw new Error(`Released Profile Agent dependency ${name} must use a portable registry version.`);
      }
    }
    const npmLock = await regularFile(path.join(runPath, "package-lock.json"));
    const pnpmLock = await regularFile(path.join(runPath, "pnpm-lock.yaml"));
    if (npmLock === pnpmLock) {
      throw new Error("Released Profile Agent with third-party dependencies requires exactly one npm or pnpm lockfile.");
    }
    return npmLock ? "npm" : "pnpm";
  }
  return null;
}

function dependencyMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Released Profile Agent dependencies must be a package map.");
  }
  const entries = Object.entries(value);
  if (entries.some(([name, spec]) => !name || typeof spec !== "string" || !spec.trim())) {
    throw new Error("Released Profile Agent dependencies must name portable versions.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

async function regularFile(filePath: string): Promise<boolean> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Released Profile Agent lockfile must be a regular file.");
  return Boolean(stat);
}

async function installLockedDependencies(manager: PackageManager, args: string[], cwd: string): Promise<void> {
  try {
    const command = process.platform === "win32" ? `${manager}.cmd` : manager;
    await execFileAsync(command, args, { cwd, timeout: 300_000, maxBuffer: 1_000_000,
      ...(process.platform === "win32" ? { shell: true } : {}) });
  } catch {
    throw new Error(`Released Profile Agent locked ${manager} dependency installation failed.`);
  }
}
