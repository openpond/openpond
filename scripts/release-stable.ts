import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Bump = "patch" | "minor" | "major";

type PackageJson = {
  version?: string;
  [key: string]: unknown;
};

const versionedPackageFiles = [
  "package.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/terminal/package.json",
  "apps/web/package.json",
  "packages/codex-provider/package.json",
  "packages/contracts/package.json",
  "packages/runtime/package.json",
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command: string, args: string[], dryRun: boolean): void {
  const display = [command, ...args].join(" ");
  if (dryRun) {
    console.log(`[dry-run] ${display}`);
    return;
  }
  console.log(display);
  execFileSync(command, args, { stdio: "inherit" });
}

function exists(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function stableVersion(input: string): string {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    fail(`Stable releases require a plain semver version like 0.1.0, received: ${input}`);
  }
  return version;
}

function parseReleaseArg(): Bump | string | null {
  const arg = process.argv.slice(2).find((item) => !item.startsWith("--"));
  if (!arg) return null;
  if (arg === "patch" || arg === "minor" || arg === "major") return arg;
  return stableVersion(arg);
}

function bumpVersion(current: string, bump: Bump): string {
  const [major, minor, patch] = current.split(".").map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
  ];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function readPackage(root: string, file: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(root, file), "utf8")) as PackageJson;
}

async function writePackage(root: string, file: string, version: string, dryRun: boolean): Promise<void> {
  const packagePath = path.join(root, file);
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
  packageJson.version = version;
  if (dryRun) {
    console.log(`[dry-run] update ${file} -> ${version}`);
    return;
  }
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function writeServerVersion(root: string, version: string, dryRun: boolean): Promise<void> {
  const serverFile = "apps/server/src/constants.ts";
  const serverPath = path.join(root, serverFile);
  const source = await readFile(serverPath, "utf8");
  const updated = source.replace(/const VERSION = "[^"]+";/, `const VERSION = "${version}";`);
  if (source === updated) fail(`Could not update ${serverFile} VERSION constant.`);
  if (dryRun) {
    console.log(`[dry-run] update ${serverFile} VERSION -> ${version}`);
    return;
  }
  await writeFile(serverPath, updated);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const allowBranch = process.argv.includes("--allow-branch");
const skipChecks = process.argv.includes("--skip-checks");
const releaseArg = parseReleaseArg();
const desktopPackage = await readPackage(root, "apps/desktop/package.json");
const currentVersion = stableVersion(desktopPackage.version ?? "");
const version =
  releaseArg === "patch" || releaseArg === "minor" || releaseArg === "major"
    ? bumpVersion(currentVersion, releaseArg)
    : releaseArg
      ? stableVersion(releaseArg)
      : currentVersion;

const initialStatus = output("git", ["status", "--porcelain"]);
if (initialStatus) {
  fail("Working tree is not clean. Commit or stash local changes before starting a stable release.");
}

const branch = output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "master" && !allowBranch) {
  fail(`Stable releases must be created from master. Current branch is ${branch}. Pass --allow-branch to override.`);
}

run("git", ["fetch", "--tags", "origin"], dryRun);
if (branch === "master" && exists("git", ["rev-parse", "--verify", "--quiet", "origin/master"])) {
  const localHead = output("git", ["rev-parse", "HEAD"]);
  const remoteHead = output("git", ["rev-parse", "origin/master"]);
  if (localHead !== remoteHead) {
    fail("Local master is not equal to origin/master. Run git pull before releasing.");
  }
}

const tag = `v${version}`;
if (exists("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) {
  fail(`Local tag ${tag} already exists.`);
}

if (exists("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])) {
  fail(`Remote tag ${tag} already exists.`);
}

if (version !== currentVersion) {
  for (const file of versionedPackageFiles) {
    await writePackage(root, file, version, dryRun);
  }
  await writeServerVersion(root, version, dryRun);
  run("bun", ["install", "--lockfile-only", "--save-text-lockfile"], dryRun);
  if (!skipChecks) {
    run("bun", ["run", "typecheck"], dryRun);
    run("bun", ["run", "test"], dryRun);
  }
  run("git", ["add", ...versionedPackageFiles, "apps/server/src/constants.ts", "bun.lock"], dryRun);
  run("git", ["commit", "-m", `chore: release ${tag}`], dryRun);
  run("git", ["push", "origin", branch], dryRun);
} else if (!skipChecks) {
  run("bun", ["run", "typecheck"], dryRun);
  run("bun", ["run", "test"], dryRun);
}

run("git", ["tag", "-a", tag, "-m", `OpenPond App ${tag}`], dryRun);
run("git", ["push", "origin", tag], dryRun);

console.log(`Stable release ${tag} is ready. GitHub Actions will publish the desktop release from that tag.`);
