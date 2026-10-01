import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageRelease } from "./prepare-package-release";

async function main(): Promise<void> {
  if (!process.argv.includes("--recover")) return preparePackageRelease("cli");
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--recover", "--dry-run"].includes(arg))) throw new Error("Usage: pnpm release:cli:stable [--dry-run]");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = (command: string, argv: string[]) => execFileSync(command, argv, { cwd: root, encoding: "utf8" }).trim();
  if (output("git", ["status", "--porcelain"])) throw new Error("CLI recovery requires a clean worktree.");
  if (output("git", ["branch", "--show-current"]) !== "master") throw new Error("CLI recovery must start on master.");
  execFileSync("gh", ["auth", "status"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["fetch", "origin", "master", "--tags"], { cwd: root, stdio: "inherit" });
  if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/master"])) throw new Error("Local master must exactly match origin/master.");
  const manifest = JSON.parse(await readFile(path.join(root, "apps/cli/package.json"), "utf8"));
  if (manifest.name !== "openpond" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("CLI recovery requires the checked-in stable openpond version.");
  const command = ["workflow", "run", "release-builds.yml", "--ref", "master", "--field", "target=cli", "--field", "channel=stable", "--field", `version=${manifest.version}`];
  if (args.includes("--dry-run")) console.log(`[dry-run] gh ${command.join(" ")}`);
  else execFileSync("gh", command, { cwd: root, stdio: "inherit" });
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
