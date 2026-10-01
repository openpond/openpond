import { requireCurrentVersion, requirePublishedIdentity, requireReleaseIdentity, requireStableMaster } from "../scripts/cli-release-policy.mjs";
import { resolveReleaseBuildTarget } from "../scripts/release-build-target.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyPackageRelease, isTrustedCiProof, readPackageRelease, releasePackages, packageReleaseManifest } from "../scripts/package-release-scope.mjs";

// Accidental fast-lane selection could publish application-consuming changes
// without application checks. Exercise that security boundary, not YAML text.
describe("package release eligibility", () => {
  const change = (key = "evals") => ({ status: "M", path: packageReleaseManifest(key),
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

// A package release must not allocate unrelated Desktop jobs, or silently drop
// one artifact when both owners have changed versions.
describe("release artifact ownership", () => {
  test("selects a CLI bump anywhere in the complete push and rejects unrelated bases", () => {
    const directory = mkdtempSync(join(tmpdir(), "openpond-release-push-"));
    const script = resolve("scripts/release-build-target.mjs");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "--quiet", "--initial-branch=master");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Release boundary test");
      for (const owner of ["cli", "desktop"]) {
        mkdirSync(join(directory, "apps", owner), { recursive: true });
        writeFileSync(join(directory, "apps", owner, "package.json"), JSON.stringify({ version: "1.0.0" }));
      }
      git("add", "."); git("commit", "--quiet", "-m", "base");
      const before = git("rev-parse", "HEAD");
      writeFileSync(join(directory, "apps/cli/package.json"), JSON.stringify({ version: "1.1.0" }));
      git("add", "."); git("commit", "--quiet", "-m", "CLI bump");
      writeFileSync(join(directory, "README.md"), "Additional change in the same push");
      git("add", "."); git("commit", "--quiet", "-m", "followup");
      const run = (base: string) => execFileSync("node", [script], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GITHUB_EVENT_NAME: "push", RELEASE_BEFORE: base } }).trim();
      expect(run(before)).toBe("cli");
      git("checkout", "--quiet", "--orphan", "unrelated");
      git("commit", "--quiet", "-m", "unrelated history");
      const unrelated = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "master");
      expect(() => run(unrelated)).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("separates CLI/Desktop pushes, schedules and explicit recovery", () => {
    const push = { event: "push", cliVersion: "1.1.0", previousCliVersion: "1.0.0", desktopVersion: "9.0.0", previousDesktopVersion: "9.0.0" };
    expect(resolveReleaseBuildTarget(push)).toBe("cli");
    expect(resolveReleaseBuildTarget({ ...push, cliVersion: "1.0.0", desktopVersion: "9.1.0" })).toBe("desktop");
    expect(() => resolveReleaseBuildTarget({ ...push, desktopVersion: "9.1.0" })).toThrow(/separate CLI and Desktop/);
    expect(() => resolveReleaseBuildTarget({ ...push, previousCliVersion: undefined })).toThrow(/Previous release versions/);
    expect(resolveReleaseBuildTarget({ event: "workflow_dispatch", target: "cli", channel: "stable", ref: "refs/heads/master" })).toBe("cli");
    expect(() => resolveReleaseBuildTarget({ event: "workflow_dispatch", target: "cli", channel: "nightly" })).toThrow(/stable channel/);
    expect(() => resolveReleaseBuildTarget({ event: "workflow_dispatch", target: "other", channel: "stable", ref: "refs/heads/master" })).toThrow(/Unsupported release target/);
    expect(resolveReleaseBuildTarget({ event: "schedule" })).toBe("desktop");
  });
});

// Recovery must not bless another artifact/source, and queued publication must
// not downgrade latest. Version printing alone cannot detect either regression.
describe("CLI publication and recovery identity", () => {
  test("binds signed provenance to the exact artifact and approved master commit", () => {
    const sha = "a".repeat(40);
    const digest = Buffer.alloc(64, 1);
    const expected = { version: "1.2.3", sha, repository: "openpond/openpond", integrity: `sha512-${digest.toString("base64")}` };
    const metadata = { name: "openpond", version: expected.version, dist: { integrity: expected.integrity } };
    const statement = { predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: "pkg:npm/openpond@1.2.3", digest: { sha512: digest.toString("hex") } }], predicate: { buildDefinition: {
      externalParameters: { workflow: { repository: "https://github.com/openpond/openpond", ref: "refs/heads/master", path: ".github/workflows/release-builds.yml" } },
      resolvedDependencies: [{ uri: "git+https://github.com/openpond/openpond@refs/heads/master", digest: { gitCommit: sha } }],
    } } };
    const attestations = (value = statement) => ({ attestations: [{ predicateType: statement.predicateType, bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(value)).toString("base64") } } }] });
    expect(() => requirePublishedIdentity(metadata, attestations(), expected)).not.toThrow();
    for (const patch of [{ sha: "b".repeat(40) }, { integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}` }, { repository: "fork/repo" }, { version: "1.2.4" }]) {
      expect(() => requirePublishedIdentity(metadata, attestations(), { ...expected, ...patch })).toThrow();
    }
    for (const patch of [{ ref: "refs/heads/feature" }, { path: ".github/workflows/other.yml" }]) {
      const modified = structuredClone(statement);
      Object.assign(modified.predicate.buildDefinition.externalParameters.workflow, patch);
      expect(() => requirePublishedIdentity(metadata, attestations(modified), expected)).toThrow(/provenance/);
    }
    expect(() => requirePublishedIdentity(metadata, { attestations: [] }, expected)).toThrow(/provenance/);
  });
  test("permits exact recovery while refusing branch publication, latest downgrades and wrong tags", () => {
    expect(() => requireStableMaster("refs/heads/master")).not.toThrow();
    expect(() => requireStableMaster("refs/heads/feature")).toThrow(/master/);
    expect(() => resolveReleaseBuildTarget({ event: "workflow_dispatch", target: "cli", channel: "stable", ref: "refs/heads/feature" })).toThrow(/master/);
    for (const latest of [undefined, "1.2.2", "1.2.3"]) expect(() => requireCurrentVersion("1.2.3", latest)).not.toThrow();
    for (const latest of ["1.2.4", "1.10.0", "2.0.0"]) expect(() => requireCurrentVersion("1.2.3", latest)).toThrow(/downgrade/);
    const expected = { tag: "cli-v1.2.3", sha: "a".repeat(40) };
    const release = { tag_name: expected.tag, draft: false, prerelease: false };
    expect(() => requireReleaseIdentity(expected.sha, null, expected)).not.toThrow();
    expect(() => requireReleaseIdentity(expected.sha, release, expected)).not.toThrow();
    expect(() => requireReleaseIdentity("b".repeat(40), release, expected)).toThrow(/another source/);
    expect(() => requireReleaseIdentity(expected.sha, { ...release, draft: true }, expected)).toThrow(/incompatible/);
  });
});
