import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type PackageJson = {
  version?: string;
  workspaces?: string[];
  openpondReleaseVersioned?: boolean;
};

export type ReleaseVersionMismatch = {
  actual: string;
  expected: string;
  file: string;
};

export type WriteReleaseVersionOptions = {
  dryRun?: boolean;
};

const SERVER_VERSION_FILE = "apps/server/src/constants.ts";
const SERVER_VERSION_PATTERN = /export const VERSION = "([^"]+)";/;
const BUN_LOCK_FILE = "bun.lock";

type BunLock = {
  workspaces?: Record<string, { version?: string }>;
};

async function readPackageJson(file: string): Promise<PackageJson> {
  return JSON.parse(await readFile(file, "utf8")) as PackageJson;
}

async function workspacePackageFiles(root: string): Promise<string[]> {
  const rootPackage = await readPackageJson(path.join(root, "package.json"));
  const files = ["package.json"];

  for (const workspace of rootPackage.workspaces ?? []) {
    if (!workspace.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern in package.json: ${workspace}`);
    }

    const workspaceRoot = workspace.slice(0, -2);
    const entries = await readdir(path.join(root, workspaceRoot), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(path.join(workspaceRoot, entry.name, "package.json"));
    }
  }

  return files.sort();
}

export async function releaseVersionedPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const file of await workspacePackageFiles(root)) {
    const packageJson = await readPackageJson(path.join(root, file));
    if (packageJson.openpondReleaseVersioned === true) files.push(file);
  }

  if (!files.includes("package.json")) {
    throw new Error('Root package.json must set "openpondReleaseVersioned": true.');
  }
  if (files.length === 1) {
    throw new Error("No release-versioned workspaces were discovered.");
  }
  return files;
}

export async function releaseVersionMismatches(
  root: string,
  expected: string,
): Promise<ReleaseVersionMismatch[]> {
  const mismatches: ReleaseVersionMismatch[] = [];

  for (const file of await releaseVersionedPackageFiles(root)) {
    const packageJson = await readPackageJson(path.join(root, file));
    const actual = packageJson.version ?? "<missing>";
    if (actual !== expected) mismatches.push({ actual, expected, file });
  }

  const lockSource = await readFile(path.join(root, BUN_LOCK_FILE), "utf8");
  const lock = Bun.JSONC.parse(lockSource) as BunLock;
  for (const file of await releaseVersionedPackageFiles(root)) {
    if (file === "package.json") continue;
    const workspace = path.dirname(file);
    const actual = lock.workspaces?.[workspace]?.version ?? "<missing>";
    if (actual !== expected) {
      mismatches.push({ actual, expected, file: `${BUN_LOCK_FILE}#${workspace}` });
    }
  }

  const serverSource = await readFile(path.join(root, SERVER_VERSION_FILE), "utf8");
  const serverVersion = serverSource.match(SERVER_VERSION_PATTERN)?.[1] ?? "<missing>";
  if (serverVersion !== expected) {
    mismatches.push({ actual: serverVersion, expected, file: SERVER_VERSION_FILE });
  }

  return mismatches;
}

export async function assertReleaseVersion(root: string, expected: string): Promise<void> {
  const mismatches = await releaseVersionMismatches(root, expected);
  if (mismatches.length === 0) return;

  const details = mismatches
    .map(({ actual, file }) => `  - ${file}: expected ${expected}, found ${actual}`)
    .join("\n");
  throw new Error(
    `Release source versions are not ready for ${expected}:\n${details}\n` +
      `Create and merge the ${expected} version-bump PR before dispatching a stable release.`,
  );
}

export async function writeReleaseVersion(
  root: string,
  version: string,
  options: WriteReleaseVersionOptions = {},
): Promise<string[]> {
  const files = await releaseVersionedPackageFiles(root);

  for (const file of files) {
    const packagePath = path.join(root, file);
    const packageJson = await readPackageJson(packagePath);
    if (packageJson.version === version) continue;
    if (options.dryRun) {
      console.log(`[dry-run] update ${file} -> ${version}`);
      continue;
    }
    packageJson.version = version;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  const lockPath = path.join(root, BUN_LOCK_FILE);
  let lockSource = await readFile(lockPath, "utf8");
  for (const file of files) {
    if (file === "package.json") continue;
    const workspace = path.dirname(file);
    const escapedWorkspace = workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const workspacePattern = new RegExp(
      `(^    "${escapedWorkspace}": \\{\\n)([\\s\\S]*?)(^    \\},?\\n)`,
      "m",
    );
    const match = lockSource.match(workspacePattern);
    if (!match) throw new Error(`Could not find ${workspace} in ${BUN_LOCK_FILE}.`);
    const block = match[2]!;
    if (!/^      "version": "[^"]+",?$/m.test(block)) {
      throw new Error(`Could not find ${workspace}'s version in ${BUN_LOCK_FILE}.`);
    }
    const updatedBlock = block.replace(
      /^(      "version": ")[^"]+("[,]?)$/m,
      `$1${version}$2`,
    );
    lockSource = lockSource.replace(workspacePattern, `$1${updatedBlock}$3`);
  }
  if (options.dryRun) {
    console.log(`[dry-run] update ${BUN_LOCK_FILE} workspace versions -> ${version}`);
  } else {
    await writeFile(lockPath, lockSource);
  }

  const serverPath = path.join(root, SERVER_VERSION_FILE);
  const serverSource = await readFile(serverPath, "utf8");
  const currentServerVersion = serverSource.match(SERVER_VERSION_PATTERN)?.[1];
  if (!currentServerVersion) {
    throw new Error(`Could not find the exported VERSION constant in ${SERVER_VERSION_FILE}.`);
  }
  if (currentServerVersion !== version) {
    if (options.dryRun) {
      console.log(`[dry-run] update ${SERVER_VERSION_FILE} -> ${version}`);
    } else {
      await writeFile(
        serverPath,
        serverSource.replace(SERVER_VERSION_PATTERN, `export const VERSION = "${version}";`),
      );
    }
  }

  return [...files, SERVER_VERSION_FILE, BUN_LOCK_FILE];
}
