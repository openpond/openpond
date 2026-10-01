import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A manifest/version change selects its own artifact owner. Never silently
// drop one publication from an ambiguous combined version bump.
export function resolveReleaseBuildTarget(input) {
  if (input.event === "schedule") return "desktop";
  if (input.event === "workflow_dispatch") {
    const target = input.target || "desktop";
    if (!["cli", "desktop"].includes(target)) throw new Error(`Unsupported release target: ${target}`);
    if (target === "cli" && input.channel !== "stable") throw new Error("CLI-only releases require the stable channel.");
    return target;
  }
  if (input.event !== "push") throw new Error(`Unsupported release event: ${input.event}`);
  if (!input.previousCliVersion || !input.previousDesktopVersion) throw new Error("Previous release versions are required.");
  const cliChanged = input.cliVersion !== input.previousCliVersion;
  const desktopChanged = input.desktopVersion !== input.previousDesktopVersion;
  if (cliChanged && desktopChanged) throw new Error("Prepare separate CLI and Desktop version-bump PRs; a combined bump is ambiguous.");
  return cliChanged ? "cli" : "desktop";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = (target) => JSON.parse(readFileSync(`apps/${target}/package.json`, "utf8")).version;
  const previous = (target) => JSON.parse(execFileSync("git", ["show", `HEAD^:apps/${target}/package.json`], { encoding: "utf8" })).version;
  const event = process.env.GITHUB_EVENT_NAME;
  console.log(resolveReleaseBuildTarget({
    event, target: process.env.INPUT_TARGET, channel: process.env.INPUT_CHANNEL,
    cliVersion: version("cli"), desktopVersion: version("desktop"),
    ...(event === "push" ? { previousCliVersion: previous("cli"), previousDesktopVersion: previous("desktop") } : {}),
  }));
}
