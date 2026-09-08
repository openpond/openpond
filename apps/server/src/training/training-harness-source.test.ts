import { createAgentSnapshot, createHarnessRelease, createHarnessSourcePackage, sha256 } from "@openpond/harness";
import { expect, it } from "vitest";

import { assertHostedTrainingHarnessSource } from "./training-harness-source.js";

// Enabling hosted selection must not export private source or admit another
// environment through the Work-only endpoint. Artifact admission checks bytes.
it("admits portable Work source and rejects private source and unsupported environments", () => {
  const files = new Map([
    ["program.json", new TextEncoder().encode('{"runtimeProtocol":"openpond.agent-runtime.v1"}')],
    ["dependencies.json", new TextEncoder().encode('{"dependencies":{}}')],
  ]);
  const assets = [...files].map(([path, bytes], index) => ({
    id: `source-${index}`, path, contentHash: sha256(bytes), sizeBytes: bytes.byteLength,
    mediaType: "application/json", visibility: "policy" as const,
  }));
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2", id: "source-agent", sourceRelease: null,
    instructions: [], skills: [], agents: [], toolDeclarations: [], capabilityRequirements: [],
    dependencyLock: assets[1]!, portability: { portable: true, blockers: [], localOnlyAssetRefs: [], hostPrivateAssetRefs: [] }, metadata: {},
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2", id: "source-release",
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash }, program: assets[0]!, tools: [],
    lifecycle: { create: true, reset: true, step: true, collect: true, destroy: true, resetScope: "attempt" },
    graderInterface: { visibleEvidence: ["output"], privilegedEvidence: [], privateVerifierIsolation: true },
    files: assets, metadata: { runtimeProtocol: "openpond.agent-runtime.v1" },
  });
  const sourcePackage = createHarnessSourcePackage({ agentSnapshot, harnessRelease, files });
  expect(() => assertHostedTrainingHarnessSource({ environmentKind: "work", sourcePackage })).not.toThrow();
  expect(() => assertHostedTrainingHarnessSource({ environmentKind: "stateless", sourcePackage })).toThrow("Work Taskset");
  const privateSource = structuredClone(sourcePackage);
  privateSource.harnessRelease.files[0]!.visibility = "verifier";
  expect(() => assertHostedTrainingHarnessSource({ environmentKind: "work", sourcePackage: privateSource })).toThrow("policy-visible");
  const localSource = structuredClone(sourcePackage);
  localSource.agentSnapshot.portability.localOnlyAssetRefs.push("local-file");
  expect(() => assertHostedTrainingHarnessSource({ environmentKind: "work", sourcePackage: localSource })).toThrow("cannot be exported");
});
