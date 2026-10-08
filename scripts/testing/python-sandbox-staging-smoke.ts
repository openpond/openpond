import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { OpenPondSandboxInstanceClient } from "../../packages/cloud/src/sandbox/sandbox-instance-client.js";

// Stage only this executor bundle in a disposable guest. No application release,
// production endpoint, model calls, or training jobs are part of this proof.
const baseUrl = "https://staging-api.openpond.ai";
const config = JSON.parse(await readFile(join(homedir(), ".openpond", "config.json"), "utf8")) as {
  accounts?: Array<{ baseUrl?: string; apiKey?: string }>;
};
const apiKey = config.accounts?.find(account => [baseUrl, "https://staging.openpond.ai"].includes(account.baseUrl?.replace(/\/+$/, "") ?? ""))?.apiKey;
assert(apiKey, "A saved staging CLI profile is required.");
const teamsResponse = await fetch(`${baseUrl}/v1/teams`, {
  headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000),
});
assert(teamsResponse.ok, `Staging workspace lookup failed: HTTP ${teamsResponse.status}`);
const teams = await teamsResponse.json() as { teams: Array<{ id: string; isPersonalDefault: boolean }> };
const teamId = teams.teams.find(team => team.isPersonalDefault)?.id;
assert(teamId, "A personal staging workspace is required.");
const bundled = await build({
  entryPoints: ["scripts/testing/python-sandbox-guest-smoke.ts"], bundle: true,
  platform: "node", format: "esm", target: "node24", write: false,
});
const source = bundled.outputFiles[0]!.text;
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const client = new OpenPondSandboxInstanceClient({ apiKey, baseUrl });
const report: Record<string, unknown> = {
  baseUrl, sourceSha256, startedAt: new Date().toISOString(), deleted: false,
};
let sandboxId: string | undefined;
const bootstrap = process.argv.includes("--bootstrap");
try {
  const sandbox = await client.create({
    teamId, runtimeProfileId: "openpond-work-v1", visibility: "private",
    resources: { cpu: 1, memoryGb: 1, diskGb: 8 },
    budget: { maxUsd: "0.10" },
    quotas: { maxSpendUsd: "0.10", maxDurationSeconds: 900, idleTimeoutSeconds: 300, maxOpenPorts: 1 },
    // The outer test guest can fetch OS prerequisites. The executor must deny
    // network access independently of that outer policy.
    networkPolicy: { internetEgress: bootstrap ? "allow" : "block", allowedHosts: [], publicPreview: false },
    metadata: { source: "python-isolation-staging-smoke", sourceSha256 },
  }, { respondAsync: true });
  sandboxId = sandbox.id;
  report.sandboxId = sandboxId;
  console.log(JSON.stringify({ phase: "created", sandboxId, state: sandbox.state }));
  let current = sandbox;
  const deadline = Date.now() + 480_000;
  while (current.state !== "running") {
    assert(!["error", "deleted", "stopped"].includes(current.state), `Staging guest became ${current.state}`);
    assert(Date.now() < deadline, "Staging guest did not become ready within eight minutes.");
    await delay(3_000);
    const next = await client.get(sandboxId);
    if (next.state !== current.state) console.log(JSON.stringify({ phase: "provisioning", state: next.state }));
    current = next;
  }
  report.runtimeProfileId = current.runtimeProfileId;
  const setup = bootstrap ? `set -eu
if ! test -x /usr/bin/bwrap; then
  if command -v dnf >/dev/null; then dnf install -y --setopt=install_weak_deps=False bubblewrap
  elif command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y --no-install-recommends bubblewrap python3
  else exit 41; fi
fi
/usr/bin/bwrap --version
/usr/bin/python3 --version
node --version` : "/usr/bin/bwrap --version && /usr/bin/python3 --version && node --version";
  const prerequisites = await client.exec(sandboxId, { command: setup, timeoutSeconds: 180 });
  assert.equal(prerequisites.command.status, "succeeded", `Staging prerequisites failed: ${prerequisites.command.output.slice(-2_000)}`);
  report.prerequisites = prerequisites.command.output.slice(-1_000);
  console.log(JSON.stringify({ phase: "runtime-ready" }));
  await client.uploadFile(sandboxId, ".openpond/python-sandbox-smoke.mjs", source);
  const execution = await client.exec(sandboxId, {
    command: "node .openpond/python-sandbox-smoke.mjs", timeoutSeconds: 60,
  });
  assert.equal(execution.command.status, "succeeded", `Staging isolation proof failed: ${execution.command.output.slice(-3_000)}`);
  const resultLine = execution.command.output.split(/\r?\n/).findLast(line => line.startsWith('{"status":"PASS"'));
  assert(resultLine, "Guest did not return a passing proof.");
  const proof = JSON.parse(resultLine);
  assert.equal(proof.sourceSha256, sourceSha256, "Guest executed a different executor bundle.");
  report.proof = proof;
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (sandboxId) {
    try {
      let deleted = await client.delete(sandboxId, { respondAsync: true });
      const deadline = Date.now() + 120_000;
      while (deleted.state !== "deleted" && Date.now() < deadline) {
        await delay(3_000);
        deleted = await client.get(sandboxId);
      }
      assert.equal(deleted.state, "deleted", "Staging smoke guest cleanup did not complete.");
      report.deleted = true;
    } catch (error) {
      report.cleanupError = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  report.completedAt = new Date().toISOString();
  await mkdir("tmp/python-isolation-staging", { recursive: true });
  await writeFile("tmp/python-isolation-staging/report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
