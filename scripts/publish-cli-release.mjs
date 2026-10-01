import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCurrentVersion, requirePublishedIdentity, requireStableMaster } from "./cli-release-policy.mjs";

requireStableMaster(process.env.GITHUB_REF);
const { VERSION: version, RELEASE_SHA: sha, GITHUB_REPOSITORY: repository } = process.env;
if (!/^[0-9a-f]{40}$/.test(sha || "") || !repository) throw new Error("Exact release source is required.");
if (JSON.parse(readFileSync("apps/cli/package.json", "utf8")).version !== version) throw new Error("CLI manifest version differs from the release.");
const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const registry = async (suffix, optional = false) => {
  const response = await fetch(`https://registry.npmjs.org/${suffix}`, { signal: AbortSignal.timeout(30_000) });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed: ${response.status}`);
  return response.json();
};
const directory = mkdtempSync(join(tmpdir(), "openpond-cli-release-"));
try {
  // This job holds the shared publication lock. A queued older run must not
  // replace latest after a newer version was published by another trigger.
  const [packed] = JSON.parse(npm(["pack", "./apps/cli", "--ignore-scripts", "--pack-destination", directory, "--json"]));
  const expected = { version, sha, repository, integrity: packed.integrity };
  const existing = await registry(`openpond/${version}`, true);
  if (existing) {
    if (existing.dist?.integrity !== expected.integrity) throw new Error("Existing CLI version contains a different artifact; refusing recovery.");
    console.log(`openpond@${version} exists; verifying without republishing.`);
  } else {
    requireCurrentVersion(version, (await registry("openpond/latest", true))?.version);
    console.log(npm(["publish", join(directory, packed.filename), "--access", "public", "--ignore-scripts"]));
  }
  const consumer = join(directory, "consumer");
  for (let attempt = 1; attempt <= 120; attempt++) {
    const metadata = await registry(`openpond/${version}`, true);
    if (metadata) {
      if (metadata.dist?.integrity !== expected.integrity) throw new Error("Published artifact integrity mismatch.");
      // Retry only availability/verification failures. A successful audit must
      // also prove the exact artifact, workflow, branch and commit before tagging.
      let verified = false;
      try {
        npm(["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", `openpond@${version}`]);
        npm(["audit", "signatures"], consumer);
        verified = true;
      } catch (error) { console.log(`Registry signature/install verification pending: ${error.message}`); }
      if (verified) {
        const attestations = await registry(`-/npm/v1/attestations/openpond@${version}`);
        requirePublishedIdentity(metadata, attestations, expected);
        const installed = execFileSync("node", [join(consumer, "node_modules/openpond/dist/cli.js"), "--version"], { encoding: "utf8" }).trim();
        if (installed !== version) throw new Error("Installed CLI version mismatch.");
        console.log(`Verified installable openpond@${version}, artifact integrity and source provenance.`);
        break;
      }
    }
    if (attempt === 120) throw new Error(`openpond@${version} is not verifiable yet; rerun this workflow after registry propagation.`);
    console.log(`Waiting for registry availability (${attempt}/120).`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
