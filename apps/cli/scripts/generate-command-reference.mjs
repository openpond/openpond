import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { formatCliCommandReference } = await import("../src/cli/help.ts");
await writeFile(
  path.join(cliRoot, "docs", "command-reference.md"),
  formatCliCommandReference(),
  "utf8",
);
