import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  CLI_INTEGRATION_TESTS,
  CLI_RELEASE_TESTS,
  ROOT_INTEGRATION_TESTS,
} from "../scripts/test-suite-config";

const root = path.resolve(import.meta.dir, "..");

describe("test suite boundaries", () => {
  test("keeps explicit integration and release tests present and disjoint", async () => {
    const explicitCliTests = [...CLI_INTEGRATION_TESTS, ...CLI_RELEASE_TESTS];
    expect(new Set(explicitCliTests).size).toBe(explicitCliTests.length);

    for (const file of ROOT_INTEGRATION_TESTS) await access(path.join(root, file));
    for (const file of explicitCliTests) await access(path.join(root, "apps", "cli", file));
  });

  test("classifies every CLI test exactly once", async () => {
    const entries = (await readdir(path.join(root, "apps", "cli", "test")))
      .filter((entry) => entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"));
    const explicit = new Set([...CLI_INTEGRATION_TESTS, ...CLI_RELEASE_TESTS]);
    const implicitUnit = entries.map((entry) => path.join("test", entry)).filter((entry) => !explicit.has(entry));

    expect(implicitUnit.length + explicit.size).toBe(entries.length);
  });

  test("exposes one complete local push verifier and no CI skip switches", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const ciWorkflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

    expect(packageJson.scripts["verify:push"]).toBe("bun scripts/verify-push.ts");
    expect(packageJson.scripts.prepare).toBe("bun run hooks:install");
    expect(ciWorkflow).not.toContain("OPENPOND_SKIP_");
  });
});
