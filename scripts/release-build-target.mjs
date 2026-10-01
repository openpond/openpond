import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A manifest/version change selects its own artifact owner. Never silently
// drop one publication from an ambiguous combined version bump.
export function resolveReleaseBuildTarget(input) {
  if (input.event === "schedule") return "desktop";
  if (input.event === "workflow_dispatch") {
    const target = input.target || "desktop";
    if (input.channel === "stable" && input.ref !== "refs/heads/master") throw new Error("Stable releases require refs/heads/master.");
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
  const before = process.env.RELEASE_BEFORE;
  const previous = (target) => {
    if (!/^[0-9a-f]{40}$/.test(before || "") || /^0+$/.test(before)) throw new Error("A valid push before SHA is required.");
    execFileSync("git", ["merge-base", "--is-ancestor", before, "HEAD"]);
    return JSON.parse(execFileSync("git", ["show", `${before}:apps/${target}/package.json`], { encoding: "utf8" })).version;
  };
  const event = process.env.GITHUB_EVENT_NAME;
  console.log(resolveReleaseBuildTarget({
    event, target: process.env.INPUT_TARGET, channel: process.env.INPUT_CHANNEL, ref: process.env.GITHUB_REF,
    cliVersion: version("cli"), desktopVersion: version("desktop"),
    ...(event === "push" ? { previousCliVersion: previous("cli"), previousDesktopVersion: previous("desktop") } : {}),
  }));
}
