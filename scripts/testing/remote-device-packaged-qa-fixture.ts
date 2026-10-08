import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import { getOpenPondAccount, saveProfileApiKey } from "@openpond/cloud";
import { initializeHome, withOpenPondHome, updatePreferences } from "@openpond/persistence";

// Prepare only: no desktop launch, provider execution, or UI automation.
// The selected QA key is read through canonical account APIs and written using
// the isolated home's encrypted credential store. Production state is untouched.
assert(process.argv.includes("--staging"), "Explicit --staging required");
const option = (name: string, fallback: string) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]!; };
const output = path.resolve(option("--output", "tmp/remote-relay-packaged-qa/fixture.json"));
const before = await loadOpenPondAccountContext();
const captured = await loadOpenPondAccountContext("ponder-staging-qa", "https://staging.openpond.ai");
assert.equal(new URL(captured.apiBaseUrl).origin, "https://staging-api.openpond.ai");
assert(captured.token);
const authenticated = await getOpenPondAccount(captured.apiBaseUrl, captured.token);
assert.equal(authenticated.account?.id, "dzdaskv4w4");
const appHome = await mkdtemp(path.join(os.tmpdir(), "openpond-packaged-relay-qa-"));
const userData = await mkdtemp(path.join(os.tmpdir(), "openpond-packaged-relay-qa-user-data-"));
try {
  await initializeHome(appHome);
  await withOpenPondHome(appHome, () => saveProfileApiKey({ handle: "ponder-staging-qa", apiKey: captured.token!,
    baseUrl: "https://staging.openpond.ai", apiBaseUrl: "https://staging-api.openpond.ai", chatApiBaseUrl: captured.chatApiBaseUrl,
    environment: "staging", setActive: true }));
  await updatePreferences(appHome, { defaultTeamId: "a3v5vj0bxfyphbgihbgprm6f" });
  const isolated = await withOpenPondHome(appHome, () => loadOpenPondAccountContext());
  assert.equal(isolated.token, captured.token);
  assert.equal(isolated.accountState.activeProfile?.handle, "ponder-staging-qa");
  const after = await loadOpenPondAccountContext();
  assert.deepEqual(after.accountState.activeProfile, before.accountState.activeProfile);
  assert.equal(after.token, before.token);
  const fixture = { preparedAt: new Date().toISOString(), appHome, userData,
    appPath: path.resolve("release/openpond-0.2.46-linux-x86_64.AppImage"),
    qa: { ownerUserId: authenticated.account!.id, handle: authenticated.account!.handle,
      teamId: "a3v5vj0bxfyphbgihbgprm6f", api: "https://staging-api.openpond.ai" },
    sourceActiveProfilePreserved: true, providerCredentialsCopied: false,
    desktopLaunched: false, uiQualified: false };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ fixturePath: output, qa: fixture.qa, sourceActiveProfilePreserved: true,
    providerCredentialsCopied: false, desktopLaunched: false }));
} catch (error) {
  await rm(appHome, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }); throw error;
}
