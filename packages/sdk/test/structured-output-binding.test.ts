import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { bindTasksetExecutionReleases, createEnvironmentRelease, createVerifierSetRelease } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { validateTaskValue } from "@openpond/evals/task-schema";
import { createRewardBinding, createRewardRelease, compileBoundGraders, executeRewardBinding } from "@openpond/evals/rewards";
import { learningRef, sealLearningContent, sealTaskBatch, taskRecordFromEvidence, taskAttemptEvidence,
  TaskEvidenceSchema, TaskAdmissionDecisionSchema, LearningSourceSchema } from "@openpond/evals/learning";
import { bindOrdinaryModelTasksetReward, createTasksetPackage } from "../src/taskset-packages.js";
import { prepareReviewedLearningBatch } from "../src/training-learning-batch.js";
import { buildTasksetTrainingBundle } from "../src/training-bundle.js";
import { ModelProjectSchema } from "../src/model-projects.js";

// Failure story: binding a grader previously kept a strict Dataset schema in
// metadata but replaced its definition with an open object. Reviewed-batch
// preparation then silently weakened the schema sent to constrained inference.
it("preserves the authored schema through binding, supervised review and the executable bundle", async () => {
  const now = "2026-10-29T00:00:00.000Z";
  const schema = { type: "object", additionalProperties: false, properties: {
    answer: { type: "string", minLength: 4 },
  }, required: ["answer"] };
  const target = { answer: "1.00" };
  const reward = createRewardRelease({ schemaVersion: "openpond.rewardRelease.v1", id: "answer", revision: 1,
    name: "Answer", description: "", implementation: { kind: "state", config: { fields: ["answer"] } },
    rawScore: { minimum: 0, maximum: 1 }, assets: [] });
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "binding", revision: 1,
    sources: ["training", "evaluation"].map(role => ({ graderId: `answer-${role}`, reward: learningRef(reward),
      role: role as "training" | "evaluation", normalization: { kind: "identity" }, weight: 1, required: true,
      hardGate: true, privileged: true, fixtureRefs: [] })), aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [reward]);
  const environment = createEnvironmentRelease({ schemaVersion: "openpond.environmentRelease.v1", id: "text", revision: 1,
    contract: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "text", stateful: false,
      deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 1000 },
    actionSchemaRef: null, observationSchemaRef: null, stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 1, maxTotalBytes: 1 }, adapterConformanceHashes: {}, metadata: {} });
  const verifierSet = createVerifierSetRelease({ schemaVersion: "openpond.verifierSetRelease.v1", id: "verifiers", revision: 1,
    graders: compileBoundGraders(binding, [reward]), isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1000 }, calibrationReceiptRefs: [], metadata: {} });
  const source = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", environment, verifierSet, files: [],
    taskset: bindTasksetExecutionReleases({ environment, verifierSet, taskset: TasksetReleaseSchema.parse(sealLearningContent({
      schemaVersion: "openpond.tasksetRelease.v2", id: "ordinary", revision: 1,
      policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: verifierSet.graders.map(g => g.id), connectedAppScopes: [] },
      environment: environment.contract, tools: [], capabilities: [], graders: verifierSet.graders,
      tasks: [{ id: "task", clusterKey: "family", split: "train", input: { prompt: "Return the recorded answer." }, expectedOutput: target,
        policyVisibleContext: {}, privilegedContextRef: null, artifactRefs: [], tags: [] }],
      metadata: { ordinaryAuthoring: { instructions: "Return the answer as JSON." }, tasksetOutputContract: { mode: "structured_json", jsonSchema: schema, renderer: null } },
    })) }) });
  const bound = bindOrdinaryModelTasksetReward({ owner: { scopeId: "profile", modelId: "model" }, source, rewardBinding: binding, rewards: [reward], assets: [] });
  const definition = bound.modelResources!.taskDefinition;
  const learningSource = LearningSourceSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningSource.v1", id: "source", revision: 1,
    name: "Reviewed", kind: "direct", taskDefinition: learningRef(definition), enabled: true, allowedSplits: ["train"], mapping: null, adapterVersion: null }));
  const evidence = TaskEvidenceSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskEvidence.v1", id: "evidence", revision: 1,
    source: learningRef(learningSource), supersedes: null, correctionFeedbackId: null, receivedAt: now,
    submission: { schemaVersion: "openpond.taskExample.v1", sourceId: learningSource.id, idempotencyKey: "example", taskDefinition: learningRef(definition),
      exampleId: "task", attemptId: "reviewed", occurredAt: now, familyKey: "family", split: "train", input: { prompt: "Return the recorded answer." },
      expected: target, observedOutput: null, evaluatorContext: null, assets: [], provenance: { sourceRecordRef: null, mappingHash: null } } }));
  const targetGrade = await executeRewardBinding({ binding, rewards: [reward], task: taskRecordFromEvidence(evidence, definition), evidence: taskAttemptEvidence(evidence, target) });
  const decision = TaskAdmissionDecisionSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskAdmissionDecision.v1", id: "decision", revision: 1,
    evidence: learningRef(evidence), supersedes: null, actor: { kind: "human", id: "reviewer", policy: null }, evidenceValidity: "valid",
    taskAdmissibility: "approved", observedQuality: "unscored", targetApproval: "approved", approvedTarget: target, grade: null, targetGrade, note: "Reviewed fixture", decidedAt: now }));
  const batch = sealTaskBatch({ id: "batch", definition, binding, rewards: [reward], purpose: "supervised_training", evidence: [evidence], decisions: [decision], priorSplits: [], actorId: "reviewer", now });
  const prepared = prepareReviewedLearningBatch({ batch, definition, binding, rewards: [reward], evidence: [evidence], decisions: [decision], profileId: "profile" });
  const base = { schemaVersion: "openpond.baseModelPreference.v1", modelId: "fixture", revision: "revision", tokenizerRevision: "tokenizer", chatTemplateHash: "a".repeat(64), modelAssetId: null, source: "local" };
  const project = ModelProjectSchema.parse({ schemaVersion: "openpond.modelProject.v2", id: "model", profileId: "profile", name: "Schema boundary", objective: null,
    defaultDestinationId: "openpond_managed", defaultBaseModel: base, trainingSetup: { tasksetRef: learningRef(prepared.taskset), baseModel: base, method: "sft", recipe: { schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora" } }, createdAt: now, updatedAt: now });
  const hash = "b".repeat(64);
  const bundle = buildTasksetTrainingBundle({ taskset: prepared.taskset, modelProject: project, modelRunId: "run",
    runtime: { adapterId: "fixture", placement: "remote", capabilityReceipt: hash, runtimeVersion: "1", dataPlane: null },
    compute: { adapterId: "fixture", kind: "managed", deviceOrPool: "fixture", capabilityReceipt: hash, provider: null },
    engine: { adapterId: "fixture", workerVersion: "1", workerImageDigest: null, upstreamRevision: "fixture", capabilityReceipt: hash },
    approval: { approvalHash: hash, approvedAt: now, maximumSpendUsd: 1 }, openpondRelease: "fixture", workerProtocol: "fixture",
    harnessRelease: { id: "fixture", contentHash: hash }, tasksetRelease: { id: prepared.release.id, contentHash: prepared.release.contentHash }, rewardExecution: { binding, rewards: [reward] }, verifierAssets: [] });
  const executable = JSON.parse(new TextDecoder().decode(bundle.assets.get("environment.json")));
  expect(contentHash(executable.outputContract.jsonSchema)).toBe(contentHash(schema));
  expect(validateTaskValue(executable.outputContract.jsonSchema, target).valid).toBe(true);
  for (const invalid of [{}, { answer: 1 }, { answer: "1.00", extra: true }])
    expect(validateTaskValue(executable.outputContract.jsonSchema, invalid).valid).toBe(false);
});
