import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageRelease } from "./package-release-scope.mjs";

type ReleaseKind = "patch" | "minor" | "major";
const packages = {
  evals: { name: "@openpond/evals", prerequisite: "harness" },
  harness: { name: "@openpond/harness", prerequisite: null },
  sdk: { name: "openpond-sdk", prerequisite: null },
  "agent-sdk": { name: "openpond-agent-sdk", prerequisite: null },
} as const;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function preparePackageRelease(key: keyof typeof packages): Promise<void> {
  const args = process.argv.slice(2);
  const kind = args.find((arg): arg is ReleaseKind => ["patch", "minor", "major"].includes(arg));
  if (!kind || args.some((arg) => ![kind, "--dry-run"].includes(arg))) throw new Error(`Usage: pnpm release:${key}:<patch|minor|major> [--dry-run]`);
  const dryRun = args.includes("--dry-run");
  const output = (command: string, argv: string[]) => execFileSync(command, argv, { cwd: root, encoding: "utf8" }).trim();
  const exists = (command: string, argv: string[]) => spawnSync(command, argv, { cwd: root, stdio: "ignore" }).status === 0;
  const run = (command: string, argv: string[]) => {
    console.log(`${dryRun ? "[dry-run] " : ""}${[command, ...argv].join(" ")}`);
    if (!dryRun) execFileSync(command, argv, { cwd: root, stdio: "inherit" });
  };
  if (output("git", ["status", "--porcelain"])) throw new Error("Working tree must be clean before preparing a package release.");
  if (output("git", ["branch", "--show-current"]) !== "master") throw new Error("Package releases must start on master.");
  if (!exists("gh", ["auth", "status"])) throw new Error("Run `gh auth login` before releasing.");
  run("git", ["fetch", "origin", "master", "--tags"]);
  if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/master"])) throw new Error("Local master must exactly match origin/master.");
  const config = packages[key];
  const manifestPath = `packages/${key}/package.json`;
  const manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"));
  if (manifest.name !== config.name) throw new Error(`Unexpected package name in ${manifestPath}`);
  const match = String(manifest.version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) throw new Error(`Package version must be stable semver, got ${manifest.version}`);
  const [major, minor, patch] = match.slice(1).map(BigInt) as [bigint, bigint, bigint];
  const version = kind === "major" ? `${major + 1n}.0.0` : kind === "minor" ? `${major}.${minor + 1n}.0` : `${major}.${minor}.${patch + 1n}`;
  const branch = `feat/release-${key}-v${version}`;
  const title = `chore(${key}): release v${version}`;
  if (exists("git", ["rev-parse", "--verify", "--quiet", branch]) || output("git", ["ls-remote", "--heads", "origin", branch])) throw new Error(`Branch ${branch} already exists.`);
  run("git", ["switch", "-c", branch]);
  if (!dryRun) await writeFile(path.join(root, manifestPath), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  else console.log(`[dry-run] set ${manifestPath} version to ${version}`);
  run("pnpm", ["install", "--lockfile-only", "--strict-peer-dependencies=false"]);
  if (config.prerequisite) run("pnpm", ["--dir", `packages/${config.prerequisite}`, "run", "build"]);
  run("pnpm", ["run", `${key}:check`]);
  run("git", ["add", manifestPath, "pnpm-lock.yaml"]);
  run("git", ["diff", "--cached", "--check"]);
  const releaseOnly = dryRun || readPackageRelease("HEAD", "HEAD", root, true) === key;
  const lane = releaseOnly ? "Package-only CI (master additionally requires a successful CI proof on its previous SHA)." : "Ordinary CI because the staged diff includes changes beyond a single package version.";
  console.log(lane);
  run("git", ["commit", "-m", title]);
  run("git", ["push", "--set-upstream", "origin", branch]);
  const temp = await mkdtemp(path.join(os.tmpdir(), "openpond-release-"));
  try {
    const bodyFile = path.join(temp, "body.md");
    await writeFile(bodyFile, `Publishes \`${config.name}@${version}\` after this PR merges and the current commit's CI passes.\n\n${lane}\n`);
    run("gh", ["pr", "create", "--base", "master", "--head", branch, "--title", title, "--body-file", bodyFile]);
  } finally { await rm(temp, { recursive: true, force: true }); }
  console.log(`Merge the release PR after CI passes. release-${key}.yml will publish ${config.name}@${version}.`);
}
