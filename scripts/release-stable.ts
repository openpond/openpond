import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseReleaseArg,
  releasePullRequestBody,
  releasePullRequestTitle,
  resolveReleasePlan,
  stableVersion,
  type PrepareReleasePlan,
} from "./release-plan";
import { assertReleaseVersion, writeReleaseVersion } from "./release-version";

type PackageJson = { version?: string };

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

function runForOutput(command: string, args: string[], dryRun: boolean): string {
  if (dryRun) {
    console.log(`[dry-run] ${[command, ...args].join(" ")}`);
    return "";
  }
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function exists(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

async function readPackage(root: string, file: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(root, file), "utf8")) as PackageJson;
}

function assertGitHubCliReady(): void {
  if (!exists("gh", ["auth", "status"])) {
    throw new Error("GitHub CLI authentication is required. Run `gh auth login` before releasing.");
  }
}

function assertCleanMaster(): string {
  const status = output("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error("Working tree is not clean. Commit or stash local changes before releasing.");
  }

  const branch = output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "master") {
    throw new Error(`Release commands must start from master. Current branch is ${branch}.`);
  }
  return output("git", ["rev-parse", "HEAD"]);
}

function assertMasterMatchesOrigin(): void {
  if (!exists("git", ["rev-parse", "--verify", "--quiet", "origin/master"])) {
    throw new Error("origin/master is unavailable after fetching from origin.");
  }
  const localHead = output("git", ["rev-parse", "HEAD"]);
  const remoteHead = output("git", ["rev-parse", "origin/master"]);
  if (localHead !== remoteHead) {
    throw new Error(
      "Local master is not equal to origin/master. Pull the latest master before releasing.",
    );
  }
}

function assertTagAvailable(tag: string): void {
  if (exists("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) {
    throw new Error(`Local tag ${tag} already exists.`);
  }
  if (exists("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])) {
    throw new Error(`Remote tag ${tag} already exists.`);
  }
}

function assertReleaseBranchAvailable(branch: string): void {
  if (exists("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new Error(`Local release branch ${branch} already exists.`);
  }
  if (exists("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`])) {
    throw new Error(`Remote release branch ${branch} already exists.`);
  }
}

function assertOnlyExpectedFilesChanged(expectedFiles: readonly string[]): void {
  const expected = new Set(expectedFiles);
  const changed = output("git", ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const unexpected = changed.filter((file) => !expected.has(file));
  if (unexpected.length > 0) {
    const details = unexpected.map((file) => `  - ${file}`).join("\n");
    throw new Error(`Release preparation changed unexpected files:\n${details}`);
  }
}

function runChecks(dryRun: boolean, skipChecks: boolean): void {
  if (skipChecks) return;
  run("bun", ["run", "typecheck"], dryRun);
  run("bun", ["run", "test"], dryRun);
}

async function prepareReleasePullRequest(
  root: string,
  plan: PrepareReleasePlan,
  sourceSha: string,
  options: { dryRun: boolean; skipChecks: boolean },
): Promise<void> {
  assertReleaseBranchAvailable(plan.branch);
  run("git", ["switch", "-c", plan.branch], options.dryRun);

  const versionedFiles = await writeReleaseVersion(root, plan.version, { dryRun: options.dryRun });
  run("bun", ["install", "--lockfile-only", "--save-text-lockfile"], options.dryRun);
  if (!options.dryRun) {
    await assertReleaseVersion(root, plan.version);
    assertOnlyExpectedFilesChanged(versionedFiles);
  }
  runChecks(options.dryRun, options.skipChecks);
  if (!options.dryRun) assertOnlyExpectedFilesChanged(versionedFiles);

  run("git", ["add", ...versionedFiles], options.dryRun);
  run("git", ["diff", "--cached", "--check"], options.dryRun);
  run("git", ["commit", "-m", releasePullRequestTitle(plan)], options.dryRun);
  run("git", ["push", "--set-upstream", "origin", plan.branch], options.dryRun);

  const prUrl = runForOutput(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "master",
      "--head",
      plan.branch,
      "--title",
      releasePullRequestTitle(plan),
      "--body",
      releasePullRequestBody(plan, sourceSha),
    ],
    options.dryRun,
  );
  if (options.dryRun) {
    console.log(`[dry-run] Merging the ${plan.tag} release PR would trigger stable publishing.`);
    return;
  }
  console.log(`Release PR ready: ${prUrl}`);
  console.log(
    `Merge it after CI passes. The merge will publish ${plan.tag}; do not run a second release command.`,
  );
}

async function dispatchStableRecovery(
  root: string,
  version: string,
  tag: string,
  options: { dryRun: boolean; skipChecks: boolean },
): Promise<void> {
  await assertReleaseVersion(root, version);
  runChecks(options.dryRun, options.skipChecks);
  run(
    "gh",
    [
      "workflow",
      "run",
      "release-builds.yml",
      "--ref",
      "master",
      "--field",
      "channel=stable",
      "--field",
      `version=${version}`,
    ],
    options.dryRun,
  );
  console.log(
    `Manual recovery dispatch requested for ${tag}. `
      + "Follow it with: gh run list --workflow release-builds.yml",
  );
}

async function main(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipChecks = args.includes("--skip-checks");
  const request = parseReleaseArg(args);
  const desktopPackage = await readPackage(root, "apps/desktop/package.json");
  const currentVersion = stableVersion(desktopPackage.version ?? "");
  const plan = resolveReleasePlan(currentVersion, request);

  const sourceSha = assertCleanMaster();
  assertGitHubCliReady();
  run("git", ["fetch", "--tags", "origin"], dryRun);
  assertMasterMatchesOrigin();
  assertTagAvailable(plan.tag);

  if (plan.kind === "prepare") {
    await prepareReleasePullRequest(root, plan, sourceSha, { dryRun, skipChecks });
  } else {
    await dispatchStableRecovery(root, plan.version, plan.tag, { dryRun, skipChecks });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
