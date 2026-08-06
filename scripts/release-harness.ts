import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseKind = "patch" | "minor" | "major";
type PackageJson = { name: string; version: string; [key: string]: unknown };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageFile = path.join(root, "packages/harness/package.json");

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}
function run(command: string, args: string[], dryRun: boolean): void {
  if (dryRun) { console.log(`[dry-run] ${[command, ...args].join(" ")}`); return; }
  console.log([command, ...args].join(" "));
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}
function exists(command: string, args: string[]): boolean {
  return spawnSync(command, args, { cwd: root, stdio: "ignore" }).status === 0;
}
function nextVersion(current: string, kind: ReleaseKind): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Harness version must be stable semver, got ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kind = args.find((arg): arg is ReleaseKind => arg === "patch" || arg === "minor" || arg === "major");
  if (!kind) throw new Error("Usage: pnpm release:harness:<patch|minor|major> [--dry-run]");
  const dryRun = args.includes("--dry-run");
  if (output("git", ["status", "--porcelain"])) throw new Error("Working tree must be clean before preparing a Harness release.");
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== "master") throw new Error(`Harness releases must start on master, got ${branch}.`);
  if (!exists("gh", ["auth", "status"])) throw new Error("Run `gh auth login` before releasing.");
  run("git", ["fetch", "origin", "master", "--tags"], dryRun);
  if (!dryRun && output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/master"])) {
    throw new Error("Local master must exactly match origin/master.");
  }
  const manifest = JSON.parse(await readFile(packageFile, "utf8")) as PackageJson;
  const version = nextVersion(manifest.version, kind);
  const releaseBranch = `release/harness-v${version}`;
  const title = `chore(harness): release v${version}`;
  if (exists("git", ["rev-parse", "--verify", "--quiet", releaseBranch])) throw new Error(`Branch ${releaseBranch} already exists.`);
  run("git", ["switch", "-c", releaseBranch], dryRun);
  if (!dryRun) await writeFile(packageFile, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`, "utf8");
  else console.log(`[dry-run] set packages/harness/package.json version to ${version}`);
  run("pnpm", ["install", "--lockfile-only", "--strict-peer-dependencies=false"], dryRun);
  run("pnpm", ["run", "harness:check"], dryRun);
  run("git", ["add", "packages/harness/package.json", "pnpm-lock.yaml"], dryRun);
  run("git", ["diff", "--cached", "--check"], dryRun);
  run("git", ["commit", "-m", title], dryRun);
  run("git", ["push", "--set-upstream", "origin", releaseBranch], dryRun);
  run("gh", ["pr", "create", "--base", "master", "--head", releaseBranch, "--title", title, "--body", `Publishes \`@openpond/harness@${version}\` after this PR merges and CI passes. This does not change the desktop, CLI, TUI, or server SDK version.`], dryRun);
  console.log(`Merge the release PR after CI passes. release-harness.yml will publish @openpond/harness@${version}.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
