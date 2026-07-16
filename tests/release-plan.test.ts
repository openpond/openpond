import { describe, expect, test } from "vitest";

import {
  bumpVersion,
  parseGitStatusPaths,
  parseReleaseArg,
  releasePullRequestBody,
  releasePullRequestTitle,
  resolveReleasePlan,
} from "../scripts/release-plan";

describe("stable release planning", () => {
  test("preserves the first porcelain status path's leading character", () => {
    expect(
      parseGitStatusPaths(
        " M apps/cli/package.json\n M apps/desktop/package.json\n?? release-notes.md\n",
      ),
    ).toEqual([
      "apps/cli/package.json",
      "apps/desktop/package.json",
      "release-notes.md",
    ]);
  });

  test("plans protected release branches for every semantic bump", () => {
    expect(bumpVersion("0.0.27", "patch")).toBe("0.0.28");
    expect(bumpVersion("0.0.27", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.0.27", "major")).toBe("1.0.0");

    expect(resolveReleasePlan("0.0.27", "patch")).toEqual({
      branch: "feat/release-v0.0.28",
      bump: "patch",
      kind: "prepare",
      tag: "v0.0.28",
      version: "0.0.28",
    });
  });

  test("reserves no-argument and exact-version commands for manual recovery", () => {
    expect(resolveReleasePlan("0.0.27", null)).toEqual({
      kind: "publish",
      tag: "v0.0.27",
      version: "0.0.27",
    });
    expect(resolveReleasePlan("0.0.27", "v0.0.27")).toEqual({
      kind: "publish",
      tag: "v0.0.27",
      version: "0.0.27",
    });
    expect(() => resolveReleasePlan("0.0.27", "0.0.28")).toThrow(
      "Manual stable publishing must use the checked-in version 0.0.27",
    );
  });

  test("parses one release request and rejects ambiguous or invalid versions", () => {
    expect(parseReleaseArg(["patch", "--dry-run"])).toBe("patch");
    expect(parseReleaseArg(["--skip-checks"])).toBeNull();
    expect(parseReleaseArg(["v1.2.3"])).toBe("1.2.3");
    expect(() => parseReleaseArg(["patch", "minor"])).toThrow("Expected at most one release");
    expect(() => parseReleaseArg(["1.2.3-beta.1"])).toThrow("plain semver version");
  });

  test("generates the merge-triggered release PR contract", () => {
    const plan = resolveReleasePlan("0.0.27", "patch");
    if (plan.kind !== "prepare") throw new Error("expected a prepare plan");

    expect(releasePullRequestTitle(plan)).toBe("chore: release v0.0.28");
    expect(releasePullRequestBody(plan, "abc1234")).toContain(
      "Merging this PR triggers the protected stable release workflow",
    );
    expect(releasePullRequestBody(plan, "abc1234")).toContain("`abc1234`");
  });
});
