import { createAgentSnapshot, createHarnessRelease, createHarnessSourcePackage, sha256 } from "../src/index.js";

export function sourceRuntimeFixture(options: { format?: "uppercase" | "lowercase"; requiredCapability?: string } = {}) {
  const format = options.format ?? "uppercase";
  const files = new Map([
    ["program.json", new TextEncoder().encode('{"runtimeProtocol":"openpond.agent-runtime.v1"}')],
    ["dependency-lock.json", new TextEncoder().encode('{"dependencies":{}}')],
    ["instructions/system.md", new TextEncoder().encode(`Format the released label as ${format}.`)],
    ["skills/label/SKILL.md", new TextEncoder().encode("Read skills/label/reference.txt and return its label in the format specified by the released instruction.")],
    ["skills/label/reference.txt", new TextEncoder().encode("Blue")],
    ["private/grader.txt", new TextEncoder().encode("PRIVATE_GRADER_SOURCE_NOT_POLICY_CONTEXT")],
  ]);
  const assets = [...files].map(([path, bytes], index) => ({
    id: `source-${index}`, path, contentHash: sha256(bytes), sizeBytes: bytes.byteLength,
    mediaType: path.endsWith(".json") ? "application/json" : "text/plain",
    visibility: path.startsWith("private/") ? "verifier" as const : "policy" as const,
  }));
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2", id: `agent-${format}`, sourceRelease: null,
    instructions: [assets[2]!], skills: [assets[3]!], agents: [], toolDeclarations: [],
    capabilityRequirements: options.requiredCapability ? [{ id: options.requiredCapability, required: true, scopes: [], portability: "host_adapter" }] : [],
    dependencyLock: assets[1]!, portability: { portable: true, blockers: [], localOnlyAssetRefs: [], hostPrivateAssetRefs: [] }, metadata: {},
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2", id: `harness-${format}`,
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash }, program: assets[0]!, tools: [],
    lifecycle: { create: true, reset: true, step: true, collect: true, destroy: true, resetScope: "attempt" },
    graderInterface: { visibleEvidence: ["output"], privilegedEvidence: ["private_verifier"], privateVerifierIsolation: true },
    files: assets, metadata: { runtimeProtocol: "openpond.agent-runtime.v1" },
  });
  return createHarnessSourcePackage({ agentSnapshot, harnessRelease, files });
}
