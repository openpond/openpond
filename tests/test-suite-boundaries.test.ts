import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CLI_INTEGRATION_TESTS,
  CLI_RELEASE_TESTS,
  ROOT_INTEGRATION_TESTS,
} from "../scripts/test-suite-config";

const root = path.resolve(import.meta.dirname, "..");

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
    const prePushHook = await readFile(path.join(root, ".githooks", "pre-push"), "utf8");
    const testRunner = await readFile(path.join(root, "scripts", "run-tests.ts"), "utf8");

    expect(packageJson.scripts["verify:quick"]).toContain("run-tests.ts unit");
    expect(packageJson.scripts["verify:push"]).toBe("tsx scripts/verify-push.ts");
    expect(packageJson.scripts.prepare).toBe("tsx scripts/install-git-hooks.ts");
    expect(packageJson.scripts["cli:build"]).toBe(
      "pnpm run build:web && pnpm --dir apps/cli run build",
    );
    expect(prePushHook).toContain("pnpm run verify:quick");
    expect(prePushHook).not.toContain("pnpm run verify:push");
    expect(ciWorkflow).not.toContain("OPENPOND_SKIP_");
    expect(testRunner).toMatch(
      /async function runUnitTests[\s\S]*?await ensureServerWorkspaceBuild\(env\)/,
    );
    expect(testRunner).toMatch(
      /async function runIntegrationTests[\s\S]*?await ensureServerWorkspaceBuild\(env\)/,
    );
    expect(testRunner).toMatch(
      /async function runCliCompatibilitySuite[\s\S]*?await ensureServerWorkspaceBuild\(env\)/,
    );
    expect(testRunner).toContain('env.OPENPOND_TEST_REUSE_BUILD === "1"');
  });
});
