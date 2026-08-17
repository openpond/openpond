import {
  TasksetReleaseContentSchema,
  TasksetReleaseSchema,
  bindTasksetExecutionReleases,
  createEnvironmentRelease,
  createVerifierSetRelease,
} from "@openpond/evals";
import {
  contentHash,
  createAgentSnapshot,
  createHarnessRelease,
  type ImmutableAssetRef,
} from "@openpond/harness";

import { CANONICAL_LEARNING_PROOF_CASES } from "./cases.js";

export const CANDIDATE_INSTRUCTION =
  "When a task requests a saved standalone artifact, create the complete file at the declared output path, validate its structure and required content, and only then claim completion.";

const environmentContract = {
  protocolVersion: "openpond.environment.v1" as const,
  kind: "work" as const,
  entrypoint: "openpond.local-canonical-learning-proof",
  stateful: false,
  deterministicSeeds: true,
  lifecycle: ["create", "reset", "step", "collect", "destroy"] as const,
  networkPolicy: "none" as const,
  defaultTimeoutMs: 30_000,
};

const graders = [{
  id: "artifact-completion-verifier",
  version: "1",
  kind: "artifact" as const,
  weight: 1,
  hardGate: true,
  rewardEligible: true,
  privileged: true,
  config: {
    checks: [
      "declared_path",
      "media_type",
      "syntax",
      "non_empty_body",
      "required_sections",
      "prohibited_claims",
      "completion_after_validation",
    ],
  },
}];

export function canonicalLearningProofTaskset() {
  const tasks = CANONICAL_LEARNING_PROOF_CASES.map((item) => ({
    id: item.id,
    clusterKey: item.clusterKey,
    split: item.split,
    input: {
      prompt: item.prompt,
      outputPath: item.outputPath,
      mediaType: item.mediaType,
    },
    expectedOutput: {
      requiredSections: item.requiredSections,
      prohibitedClaims: item.prohibitedClaims,
    },
    policyVisibleContext: {
      outputPath: item.outputPath,
      mediaType: item.mediaType,
    },
    privilegedContextRef: `expected-${item.id}`,
    artifactRefs: [],
    requiredOutputs: [{
      path: item.outputPath,
      mediaType: item.mediaType,
      schemaRef: null,
      maxBytes: 1_000_000,
      metadata: { artifactKind: item.artifactKind },
    }],
    tags: [item.cohort, item.artifactKind, "artifact-completion"],
  }));
  const content = TasksetReleaseContentSchema.parse({
    schemaVersion: "openpond.tasksetRelease.v2",
    id: "canonical-learning-loop-html-v1",
    revision: 1,
    policy: {
      policyVisibleFields: ["input", "policyVisibleContext", "requiredOutputs"],
      privilegedFields: ["expectedOutput"],
      hiddenGraderRefs: ["artifact-completion-verifier"],
      connectedAppScopes: [],
    },
    environment: environmentContract,
    tools: [],
    capabilities: [{
      id: "filesystem.workspace",
      required: true,
      scopes: ["outputs:write"],
      portability: "host_adapter",
    }],
    tasks,
    graders,
    metadata: {
      proofKind: "deterministic_protocol_conformance",
      adaptationCount: 8,
      developmentCount: 4,
      heldOutCount: 6,
      controlCount: 2,
    },
  });
  const taskset = TasksetReleaseSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
  const environment = createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1",
    id: "canonical-learning-loop-environment-v1",
    revision: 1,
    contract: environmentContract,
    actionSchemaRef: null,
    observationSchemaRef: null,
    stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 10, maxTotalBytes: 10_000_000 },
    adapterConformanceHashes: {
      local: contentHash("openpond.local-canonical-learning-proof.v1"),
    },
    metadata: { providerCalls: 0 },
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1",
    id: "canonical-learning-loop-verifier-v1",
    revision: 1,
    graders,
    isolation: {
      processBoundary: "isolated_process",
      networkPolicy: "none",
      defaultTimeoutMs: 10_000,
    },
    calibrationReceiptRefs: [],
    metadata: { fixtureCoverage: ["oracle", "negative", "prompt_injection"] },
  });
  return {
    taskset: bindTasksetExecutionReleases({ taskset, environment, verifierSet }),
    environment,
    verifierSet,
  };
}

export function canonicalLearningProofHarnesses() {
  const program = asset(
    "canonical-proof-program",
    ".openpond/harness/program.json",
    "openpond.local-artifact-policy.v1",
  );
  const dependencyLock = asset(
    "canonical-proof-lock",
    ".openpond/harness/dependency-lock.json",
    "canonical-proof-lock-v1",
  );
  const baselineSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2",
    id: "canonical-proof-baseline-agent",
    sourceRelease: null,
    instructions: [],
    skills: [],
    agents: [],
    toolDeclarations: [],
    capabilityRequirements: [],
    dependencyLock,
    portability: {
      portable: true,
      blockers: [],
      localOnlyAssetRefs: [],
      hostPrivateAssetRefs: [],
    },
    metadata: {},
  });
  const instruction = asset(
    "canonical-proof-artifact-instruction",
    "instructions/artifact-completion.md",
    CANDIDATE_INSTRUCTION,
  );
  const candidateSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2",
    id: "canonical-proof-candidate-agent",
    sourceRelease: null,
    instructions: [instruction],
    skills: [],
    agents: [],
    toolDeclarations: [],
    capabilityRequirements: [],
    dependencyLock,
    portability: {
      portable: true,
      blockers: [],
      localOnlyAssetRefs: [],
      hostPrivateAssetRefs: [],
    },
    metadata: {},
  });
  const release = (id: string, snapshot: typeof baselineSnapshot, files: ImmutableAssetRef[]) =>
    createHarnessRelease({
      schemaVersion: "openpond.harnessRelease.v2",
      id,
      agentSnapshot: { id: snapshot.id, contentHash: snapshot.contentHash },
      program,
      tools: [],
      lifecycle: {
        create: true,
        reset: true,
        step: true,
        collect: true,
        destroy: true,
        resetScope: "attempt",
      },
      graderInterface: {
        visibleEvidence: ["output", "artifacts"],
        privilegedEvidence: ["expectedOutput"],
        privateVerifierIsolation: true,
      },
      files,
      metadata: { proofKind: "deterministic_protocol_conformance" },
    });
  return {
    baseline: release("canonical-proof-baseline-harness", baselineSnapshot, []),
    candidate: release("canonical-proof-candidate-harness", candidateSnapshot, [instruction]),
    instruction,
  };
}

function asset(id: string, path: string, value: string): ImmutableAssetRef {
  return {
    id,
    path,
    contentHash: contentHash(value),
    sizeBytes: Buffer.byteLength(value),
    mediaType: path.endsWith(".md") ? "text/markdown" : "application/json",
    visibility: "policy",
  };
}
