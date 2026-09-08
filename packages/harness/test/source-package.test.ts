import { describe, expect, test } from "vitest";

import {
  contentHash,
  createAgentSnapshot,
  createHarnessRelease,
  createHarnessSourcePackage,
  harnessSourcePackageFiles,
  resolveHarnessSourceSelection,
  sha256,
  validateHarnessSourcePackage,
  type ImmutableAssetRef,
} from "../src/index.js";

describe("released Harness source transport", () => {
  // The outer transport hash must not make substituted or omitted source valid;
  // already-captured runs must retain their bytes after an author edits source.
  test("retains the complete release and rejects rewritten bytes, dependencies and private instructions", () => {
    const files = new Map([
      ["program.json", new TextEncoder().encode('{"runtimeProtocol":"openpond.agent-runtime.v1"}')],
      ["dependencies.json", new TextEncoder().encode("{}")],
      ["instructions/system.md", new TextEncoder().encode("Answer using the released rule.")],
      ["skills/report/SKILL.md", new TextEncoder().encode("Read reference.txt before writing the report.")],
      ["skills/report/reference.txt", new TextEncoder().encode("Released report terminology.")],
      ["private/check.bin", new Uint8Array([0, 255, 128, 1])],
    ]);
    const assets: ImmutableAssetRef[] = [...files].map(([path, bytes], index) => ({
      id: `source-${index}`, path, contentHash: sha256(bytes), sizeBytes: bytes.byteLength,
      mediaType: path.endsWith(".bin") ? "application/octet-stream" : "text/plain",
      visibility: path.startsWith("private/") ? "verifier" : "policy",
    }));
    const agentSnapshot = createAgentSnapshot({
      schemaVersion: "openpond.agentSnapshot.v2", id: "test-agent", sourceRelease: null,
      instructions: [assets[2]!], skills: [assets[3]!], agents: [], toolDeclarations: [], capabilityRequirements: [],
      dependencyLock: assets[1]!, portability: { portable: true, blockers: [], localOnlyAssetRefs: [], hostPrivateAssetRefs: [] }, metadata: {},
    });
    const harnessRelease = createHarnessRelease({
      schemaVersion: "openpond.harnessRelease.v2", id: "test-release",
      agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash }, program: assets[0]!, tools: [],
      lifecycle: { create: true, reset: true, step: true, collect: true, destroy: true, resetScope: "attempt" },
      graderInterface: { visibleEvidence: ["output"], privilegedEvidence: ["private_verifier"], privateVerifierIsolation: true },
      files: assets, metadata: { runtimeProtocol: "openpond.agent-runtime.v1" },
    });
    const captured = createHarnessSourcePackage({ agentSnapshot, harnessRelease, files });
    const expectedRelease = { id: harnessRelease.id, contentHash: harnessRelease.contentHash };
    const selection = { schemaVersion: "openpond.harnessSourceSelection.v1", mode: "selected_release",
      harnessRelease: expectedRelease, sourcePackageHash: captured.contentHash };
    expect(resolveHarnessSourceSelection({ selection, sourcePackage: captured, expectedRelease }).sourcePackage).toEqual(captured);
    expect(() => resolveHarnessSourceSelection({ selection, expectedRelease })).toThrow();
    expect(() => resolveHarnessSourceSelection({ selection: { ...selection, mode: "taskset_owned", sourcePackageHash: null }, sourcePackage: captured, expectedRelease }))
      .toThrow("cannot include a selected Harness");
    expect(harnessSourcePackageFiles(JSON.parse(JSON.stringify(captured)))).toEqual(files);
    files.get("instructions/system.md")!.fill(0);
    expect(new TextDecoder().decode(harnessSourcePackageFiles(captured).get("instructions/system.md")))
      .toBe("Answer using the released rule.");
    const replaceHash = <T extends { contentHash: string }>(value: T): T => {
      const { contentHash: _hash, ...content } = value;
      return { ...content, contentHash: contentHash(content) } as T;
    };
    const modified = structuredClone(captured);
    modified.files.find(file => file.path === "instructions/system.md")!.base64 = btoa("forged");
    expect(() => validateHarnessSourcePackage(replaceHash(modified))).toThrow("immutable bytes");
    const omitted = { ...captured, files: captured.files.filter(file => file.path !== "skills/report/reference.txt") };
    expect(() => validateHarnessSourcePackage(replaceHash(omitted))).toThrow("missing released files");
    const duplicate = { ...captured, files: [...captured.files, captured.files[0]!] };
    expect(() => validateHarnessSourcePackage(replaceHash(duplicate))).toThrow("duplicate files");
    expect(() => validateHarnessSourcePackage(captured, { id: harnessRelease.id, contentHash: "0".repeat(64) })).toThrow("selected release");
    const privateInstruction = structuredClone(captured);
    privateInstruction.agentSnapshot.instructions[0]!.visibility = "verifier";
    privateInstruction.agentSnapshot = replaceHash(privateInstruction.agentSnapshot);
    privateInstruction.harnessRelease.agentSnapshot.contentHash = privateInstruction.agentSnapshot.contentHash;
    privateInstruction.harnessRelease.files.find(file => file.path === "instructions/system.md")!.visibility = "verifier";
    privateInstruction.harnessRelease = replaceHash(privateInstruction.harnessRelease);
    expect(() => validateHarnessSourcePackage(replaceHash(privateInstruction))).toThrow("is private");
  });
});
