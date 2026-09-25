import { describe, expect, test } from "vitest";
import { classifyPackageRelease, isTrustedCiProof, readPackageRelease, releasePackages } from "../scripts/package-release-scope.mjs";

// Accidental fast-lane selection could publish application-consuming changes
// without application checks. Exercise that security boundary, not YAML text.
describe("package release eligibility", () => {
  const change = (key = "evals") => ({ status: "M", path: `packages/${key}/package.json`,
    before: JSON.stringify({ name: releasePackages[key], version: "1.2.3", dependencies: { zod: "^4" } }),
    after: JSON.stringify({ dependencies: { zod: "^4" }, version: "1.2.4", name: releasePackages[key] }),
  });
  test("accepts only an increasing stable version with identical remaining metadata", () => {
    for (const key of Object.keys(releasePackages)) expect(classifyPackageRelease([change(key)])).toBe(key);
    for (const version of ["1.2.3", "1.2.2", "1.2.4-rc.1", "01.2.4", 124, null]) {
      const item = change(); item.after = JSON.stringify({ ...JSON.parse(item.after), version });
      expect(classifyPackageRelease([item])).toBe("");
    }
    for (const field of ["dependencies", "exports", "scripts", "peerDependencies", "publishConfig", "name"]) {
      const item = change(); item.after = JSON.stringify({ ...JSON.parse(item.after), [field]: "changed" });
      expect(classifyPackageRelease([item])).toBe("");
    }
  });
  test("rejects combined changes, lockfile uncertainty, deletions, renames and malformed JSON", () => {
    for (const extra of [change("harness"), { path: "pnpm-lock.yaml" }, { path: "packages/evals/src/index.ts" }]) {
      expect(classifyPackageRelease([change(), extra])).toBe("");
    }
    for (const status of ["A", "D", "R100"]) expect(classifyPackageRelease([{ ...change(), status }])).toBe("");
    expect(classifyPackageRelease([{ ...change(), after: "invalid" }])).toBe("");
    expect(readPackageRelease("0000000000000000000000000000000000000000", "HEAD")).toBe("");
    expect(readPackageRelease("missing-release-base", "HEAD")).toBe("");
  });
  test("requires the exact master workflow, SHA and successful latest attempt", () => {
    const sha = "a".repeat(40); const repo = "openpond/openpond";
    const run = { head_sha: sha, event: "push", head_branch: "master", repository: { full_name: repo }, head_repository: { full_name: repo }, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", run_attempt: 2 };
    const jobs = [{ name: "Checks", head_sha: sha, status: "completed", conclusion: "success", run_attempt: 2 }];
    expect(isTrustedCiProof(run, jobs, sha, repo)).toBe(true);
    for (const patch of [{ event: "pull_request" }, { head_sha: "b".repeat(40) }, { path: ".github/workflows/spoof.yml" }, { conclusion: "failure" }, { status: "in_progress" }, { head_repository: { full_name: "fork/repo" } }, { run_attempt: 3 }]) {
      expect(isTrustedCiProof({ ...run, ...patch }, jobs, sha, repo)).toBe(false);
    }
    for (const badJobs of [[], [...jobs, ...jobs], [{ ...jobs[0], conclusion: "skipped" }]]) expect(isTrustedCiProof(run, badJobs, sha, repo)).toBe(false);
  });
});
