import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { formatCliCommandReference } from "../src/cli/help";

describe("CLI generated command reference", () => {
  test("matches the authoritative command registry", async () => {
    const file = await readFile(path.join(import.meta.dir, "..", "docs", "command-reference.md"), "utf8");
    expect(file).toBe(formatCliCommandReference());
  });
});
