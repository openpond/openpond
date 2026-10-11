import { expect, test, vi } from "vitest";
import { createAgentSnapshot, createHarnessRelease, createHarnessSourcePackage, createHarnessPolicySourcePackage, sha256 } from "@openpond/harness";
import { createTrainingClient } from "../src/training.js";

function sourceFixture() {
  const files = new Map([["program.json", new TextEncoder().encode('{"runtimeProtocol":"openpond.agent-runtime.v1"}')], ["lock.json", new TextEncoder().encode('{"dependencies":{}}')]]);
  const assets = [...files].map(([path, bytes]) => ({ id: path, path, contentHash: sha256(bytes), sizeBytes: bytes.byteLength, mediaType: "application/json", visibility: "policy" as const }));
  const agentSnapshot = createAgentSnapshot({ schemaVersion: "openpond.agentSnapshot.v2", id: "agent", sourceRelease: null,
    instructions: [], skills: [], agents: [], toolDeclarations: [], capabilityRequirements: [], dependencyLock: assets[1]!,
    portability: { portable: true, blockers: [], localOnlyAssetRefs: [], hostPrivateAssetRefs: [] }, metadata: {} });
  const harnessRelease = createHarnessRelease({ schemaVersion: "openpond.harnessRelease.v2", id: "harness/shared",
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash }, program: assets[0]!, tools: [],
    lifecycle: { create: true, reset: true, step: true, collect: true, destroy: true, resetScope: "attempt" },
    graderInterface: { visibleEvidence: ["output"], privilegedEvidence: [], privateVerifierIsolation: true }, files: assets, metadata: { runtimeProtocol: "openpond.agent-runtime.v1" } });
  return createHarnessSourcePackage({ agentSnapshot, harnessRelease, files });
}

// A successful HTTP response must still match the source the caller selected;
// private source must be rejected before crossing the transport boundary.
test("publishes and retrieves exact source through authenticated Training API without starting Jobs", async () => {
  const source = sourceFixture();
  const reference = { id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash };
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(init?.method === "PUT"
    ? { schemaVersion: "openpond.trainingHarnessSourcePublication.v1", harnessRelease: reference, sourcePackageHash: source.contentHash, sizeBytes: JSON.stringify(source).length }
    : source));
  const client = createTrainingClient({ baseUrl: "https://training.example", headers: { Authorization: "Bearer test", "x-openpond-team-id": "team" }, fetch: request });
  expect((await client.publishHarnessSource(source)).sourcePackageHash).toBe(source.contentHash);
  expect(await client.getHarnessSource(reference)).toEqual(source);
  expect(request.mock.calls.map(([url]) => url)).toEqual(Array(2).fill(`https://training.example/v1/training/harness-sources/harness%2Fshared/${reference.contentHash}`));
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("x-openpond-team-id")).toBe("team");
  await expect(client.getHarnessSource({ ...reference, contentHash: "a".repeat(64) })).rejects.toThrow("selected release");
  const { contentHash: _snapshotHash, ...snapshotContent } = source.agentSnapshot;
  const { contentHash: _releaseHash, ...releaseContent } = source.harnessRelease;
  const blockedSnapshot = createAgentSnapshot({ ...snapshotContent, portability: { ...source.agentSnapshot.portability, portable: false, blockers: ["local-only"] } });
  const blockedRelease = createHarnessRelease({ ...releaseContent, agentSnapshot: { id: blockedSnapshot.id, contentHash: blockedSnapshot.contentHash } });
  const blocked = createHarnessSourcePackage({ agentSnapshot: blockedSnapshot, harnessRelease: blockedRelease, files: new Map(source.files.map(file => [file.path, Uint8Array.from(atob(file.base64), value => value.charCodeAt(0))])) });
  const calls = request.mock.calls.length;
  await expect(client.publishHarnessSource(blocked)).rejects.toThrow("policy-visible");
  expect(request).toHaveBeenCalledTimes(calls);
});

// Released Profiles contain private checks; publishing their public projection
// must retain release identity and refuse any rehashed leak before HTTP.
test("publishes and retrieves a policy projection without private verifier bytes", async () => {
  const original = sourceFixture();
  const bytes = new TextEncoder().encode("private checker secret");
  const { contentHash: _hash, ...release } = original.harnessRelease;
  const full = createHarnessSourcePackage({ agentSnapshot: original.agentSnapshot,
    harnessRelease: createHarnessRelease({ ...release, files: [...release.files,
      { id: "private-check", path: "private/check.txt", contentHash: sha256(bytes), sizeBytes: bytes.length, mediaType: "text/plain", visibility: "verifier" }] }),
    files: new Map([...original.files.map(file => [file.path, Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))] as const), ["private/check.txt", bytes]]) });
  const source = createHarnessPolicySourcePackage(full);
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(init?.method === "PUT"
    ? { schemaVersion: "openpond.trainingHarnessSourcePublication.v1", harnessRelease: { id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash }, sourcePackageHash: source.contentHash, sizeBytes: JSON.stringify(source).length } : source));
  const client = createTrainingClient({ baseUrl: "https://training.example", fetch: request });
  await client.publishHarnessSource(source);
  expect(request.mock.calls[0]?.[1]?.body).not.toContain(btoa("private checker secret"));
  expect(await client.getHarnessSource({ id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash })).toEqual(source);
  await expect(client.publishHarnessSource(full)).rejects.toThrow("policy-visible");
  expect(request).toHaveBeenCalledTimes(2);
});
