import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { formatCliCommandReference } from "../src/cli/help";

describe("CLI generated command reference", () => {
  test("matches the authoritative command registry", async () => {
    const file = await readFile(path.join(import.meta.dirname, "..", "docs", "command-reference.md"), "utf8");
    expect(file).toBe(formatCliCommandReference());
  });
});
