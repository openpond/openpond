import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ROOT_IMAGE_TESTS,
  ROOT_MEMORY_TESTS,
  ROOT_SYSTEM_TESTS,
} from "./test-suite-manifest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const unitRoots = ["tests", "apps/web/src", "packages/cloud/src"] as const;
const explicitUnitMarker = "@test-tier unit";
const boundaryPatterns = [
  { label: "child process", pattern: /(?:node:)?child_process/ },
  { label: "SQLite", pattern: /(?:node:)?sqlite|SqliteStore/ },
  { label: "temporary filesystem", pattern: /\bmkdtemp(?:Sync)?\b/ },
  { label: "network listener", pattern: /\.listen\s*\(|startFetchTestServer|(?:node:)?(?:http|net)["']/ },
] as const;

async function main(): Promise<void> {
  const trackedFiles = await listTrackedFiles();
  const candidates = [...trackedFiles]
    .filter((file) => file.endsWith(".test.ts"))
    .filter((file) => unitRoots.some((directory) => file.startsWith(`${directory}/`)))
    .sort();
  const systemTests = new Set(
    ROOT_SYSTEM_TESTS.filter((entry) => !entry.includes("*")),
  );
  const specialTests = new Set([...ROOT_MEMORY_TESTS, ...ROOT_IMAGE_TESTS]);
  const failures: string[] = [];

  for (const listed of [...systemTests, ...specialTests]) {
    if (!trackedFiles.has(listed)) {
      failures.push(`${listed}: listed in the test manifest but is not tracked by Git`);
    }
  }

  for (const file of candidates) {
    if (systemTests.has(file) || specialTests.has(file)) continue;
    const source = await readFile(path.join(root, file), "utf8");
    if (source.includes(explicitUnitMarker)) continue;
    const matches = boundaryPatterns
      .filter(({ pattern }) => pattern.test(source))
      .map(({ label }) => label);
    if (matches.length > 0) {
      failures.push(
        `${file}: crosses ${matches.join(", ")} boundaries; move it to ROOT_SYSTEM_TESTS or document a mocked-only exception with // ${explicitUnitMarker}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Test tier policy failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
  console.log(`Test tier policy passed for ${candidates.length} fast-test candidates.`);
}

async function listTrackedFiles(): Promise<Set<string>> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--", ...unitRoots, "apps/server/src"],
    { cwd: root, encoding: "utf8" },
  );
  return new Set(stdout.split("\0").filter(Boolean));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
