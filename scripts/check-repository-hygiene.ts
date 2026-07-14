import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ignoredTracked = splitNullTerminated(
  await captureGit(["ls-files", "-ci", "--exclude-standard", "-z"]),
);
const tracked = splitNullTerminated(await captureGit(["ls-files", "-z"]));
const forbiddenTracked = tracked.filter(isGeneratedOutputPath);

if (ignoredTracked.length > 0 || forbiddenTracked.length > 0) {
  if (ignoredTracked.length > 0) {
    console.error("[repository-hygiene] ignored files are still tracked:");
    for (const file of ignoredTracked) console.error(`  ${file}`);
  }
  if (forbiddenTracked.length > 0) {
    console.error("[repository-hygiene] generated output is tracked:");
    for (const file of forbiddenTracked) console.error(`  ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Repository hygiene check passed: ${tracked.length} tracked files, no ignored or generated output tracked.`,
  );
}

function isGeneratedOutputPath(file: string): boolean {
  if (file.startsWith("jobs/")) return true;
  const segments = file.split("/");
  return segments.some((segment) =>
    segment === ".openpond" ||
    segment === ".openpond-negative" ||
    segment === ".openpond-test-fixtures" ||
    segment === "release-smoke" ||
    segment.startsWith(".phase5-")
  );
}

function splitNullTerminated(value: string): string[] {
  return value.split("\0").filter(Boolean).sort();
}

async function captureGit(args: string[]): Promise<string> {
  const child = spawn("git", args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`);
  }
  return stdout;
}
