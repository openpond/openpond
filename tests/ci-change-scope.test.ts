import { describe, expect, test } from "vitest";
import { classifyCiChanges } from "../scripts/ci-change-scope.mjs";

describe("CI change scope", () => {
  test("keeps a focused application change on the targeted lane", () => {
    const result = classifyCiChanges([
      "apps/web/src/components/settings/SettingsView.tsx",
      "tests/settings-surface.test.tsx",
    ]);

    expect(result).toMatchObject({ full: false, affectedTests: true, typecheck: true });
  });

  test("runs full CI for master, shared contracts, and broad cross-domain changes", () => {
    expect(classifyCiChanges(["apps/web/src/api.ts"], "push").full).toBe(true);
    expect(classifyCiChanges(["packages/contracts/src/index.ts"]).full).toBe(true);
    expect(classifyCiChanges([
      "apps/web/src/api.ts",
      "apps/server/src/index.ts",
      "packages/runtime/src/index.ts",
    ]).full).toBe(true);
  });

  test("lets documentation and workflow-only changes avoid the full matrix", () => {
    expect(classifyCiChanges(["docs/testing.md"])).toMatchObject({
      docsOnly: true,
      full: false,
      install: false,
    });
    expect(classifyCiChanges([
      "apps/cli/README.md",
      "packages/agent-sdk/README.md",
    ])).toMatchObject({
      agentSdk: false,
      cli: false,
      docsOnly: true,
      full: false,
      install: false,
    });
    expect(classifyCiChanges([".github/workflows/release-sdk.yml"])).toMatchObject({
      full: false,
      release: true,
      workflow: true,
    });
  });

  test("treats test-runner and large changes as full-suite risks", () => {
    expect(classifyCiChanges(["vitest.config.ts"]).full).toBe(true);
    expect(classifyCiChanges(Array.from({ length: 51 }, (_, index) => `tests/fixture-${index}.test.ts`)).full).toBe(true);
  });

  test("runs the full suite when production code is deleted, but not for a deleted test", () => {
    expect(classifyCiChanges(
      ["apps/server/src/legacy.ts"],
      "pull_request",
      ["apps/server/src/legacy.ts"],
    ).full).toBe(true);
    expect(classifyCiChanges(
      ["tests/legacy.test.ts"],
      "pull_request",
      ["tests/legacy.test.ts"],
    ).full).toBe(false);
  });
});
