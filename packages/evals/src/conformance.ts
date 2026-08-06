import { contentHash, withContentHash } from "./common.js";
import { createAgentSnapshot, createHarnessRelease } from "./harness.js";
import { createRunManifest } from "./runs.js";
import { TasksetReleaseSchema, type TasksetRelease } from "./tasksets.js";

const EMPTY_HASH = contentHash("");
const dependencyLock = { id: "fixture-lock", path: "package-lock.json", contentHash: EMPTY_HASH, sizeBytes: 0, mediaType: "application/json", visibility: "policy" as const };
const program = { id: "fixture-program", path: "harness.mjs", contentHash: EMPTY_HASH, sizeBytes: 0, mediaType: "text/javascript", visibility: "policy" as const };

export const genericToolConformance = fixture("generic-tool-v1", [
  { name: "lookup", description: "Look up a deterministic value.", inputSchema: { type: "object" }, inputSchemaHash: contentHash({ type: "object" }), sideEffect: "read" as const, timeoutMs: 1_000 },
]);

export const marketingPortfolioConformance = fixture("marketing-portfolio-v1", [
  { name: "get_portfolio_snapshot", description: "Read the fixture portfolio.", inputSchema: { type: "object" }, inputSchemaHash: contentHash({ type: "object" }), sideEffect: "read" as const, timeoutMs: 1_000 },
  { name: "submit_budget_decision", description: "Submit a fixture decision.", inputSchema: { type: "object" }, inputSchemaHash: contentHash({ type: "object" }), sideEffect: "write" as const, timeoutMs: 1_000 },
]);

function fixture(id: string, tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; inputSchemaHash: string; sideEffect: "read" | "write"; timeoutMs: number }>) {
  const snapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2",
    id: `${id}-agent`,
    sourceRelease: null,
    instructions: [], skills: [], agents: [], toolDeclarations: tools,
    capabilityRequirements: [], dependencyLock,
    portability: { portable: true, blockers: [], localOnlyAssetRefs: [], hostPrivateAssetRefs: [] },
    metadata: { conformanceFixture: id },
  });
  const harness = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2",
    id: `${id}-harness`,
    agentSnapshot: { id: snapshot.id, contentHash: snapshot.contentHash },
    program,
    tools,
    lifecycle: { create: true, reset: true, step: true, collect: true, destroy: true, resetScope: "attempt" },
    graderInterface: { visibleEvidence: ["output"], privilegedEvidence: ["expected"], privateVerifierIsolation: true },
    files: [], metadata: { conformanceFixture: id },
  });
  const tasksetContent = {
    schemaVersion: "openpond.tasksetRelease.v2" as const,
    id: `${id}-taskset`, revision: 1,
    policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: [], connectedAppScopes: [] },
    environment: { protocolVersion: "openpond.environment.v1", kind: "agent", entrypoint: id, stateful: true, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 5_000 },
    tools,
    capabilities: [],
    tasks: [
      { id: `${id}-train`, clusterKey: `${id}-train`, split: "train" as const, input: { prompt: "Use the declared tool." }, expectedOutput: { text: "done" }, policyVisibleContext: {}, privilegedContextRef: `${id}-expected`, artifactRefs: [], tags: ["conformance"] },
      { id: `${id}-frozen`, clusterKey: `${id}-frozen`, split: "frozen_eval" as const, input: { prompt: "Repeat the protocol." }, expectedOutput: { text: "done" }, policyVisibleContext: {}, privilegedContextRef: `${id}-expected-frozen`, artifactRefs: [], tags: ["conformance"] },
    ],
    graders: [{ id: `${id}-exact`, version: "1", kind: "content" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, config: { outputField: "text", expectedField: "text" } }],
    metadata: { conformanceFixture: id },
  };
  const taskset = TasksetReleaseSchema.parse(withContentHash(tasksetContent)) as TasksetRelease;
  const manifest = createRunManifest({
    schemaVersion: "openpond.runManifest.v1",
    id: `${id}-run`,
    harnessRelease: { id: harness.id, contentHash: harness.contentHash },
    tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash },
    model: { provider: "fixture", model: "scripted", revision: "1", artifactHash: null, tokenizerRevision: null, chatTemplateHash: null },
    runtimeTarget: { adapterId: "fixture-runtime", placement: "local", runtimeVersion: "1", capabilityReceipt: contentHash(tools.map((tool) => tool.name)) },
    limits: { maxTurns: 8, timeoutMs: 5_000, maxOutputBytes: 1_000_000, maximumSpendUsd: 0 },
    approval: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    metadata: { conformanceFixture: id },
  });
  return { snapshot, harness, taskset, manifest };
}
