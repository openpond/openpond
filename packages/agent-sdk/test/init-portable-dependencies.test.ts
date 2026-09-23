import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { initCommand } from "../src/commands/init.js";

test("Agent bootstrap pins a portable SDK version for committed Profile source", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-agent-init-"));
  try {
    const target = path.join(directory, "agent");
    await initCommand({ command: "init", cwd: target, outDir: path.join(directory, "out"), json: true });
    const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["openpond-agent-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
