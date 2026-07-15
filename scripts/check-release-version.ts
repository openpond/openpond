import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertReleaseVersion } from "./release-version";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const version = readArg("version")?.replace(/^v/, "");
if (!version) {
  console.error("Expected --version.");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  await assertReleaseVersion(root, version);
  console.log(`Release source versions match ${version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
