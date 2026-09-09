import { expect, it } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { TaskDefinitionSchema, TaskEvidenceSchema, TaskAdmissionDecisionSchema, LearningSourceSchema,
  sealLearningContent, learningRef, sealTaskBatch, taskRecordFromEvidence, taskAttemptEvidence } from "@openpond/evals/learning";
import { RewardReleaseSchema, RewardBindingSchema, executeRewardBinding } from "@openpond/evals/rewards";
import { prepareReviewedLearningBatch } from "../src/training-learning-batch.js";
import { validateTaskset } from "../src/taskset-drafts.js";

async function reviewed(bytes = new TextEncoder().encode("Source facts")) {
  const now = "2026-09-09T00:00:00Z";
  const asset = { id: "source-file", path: "inputs/source.txt", mediaType: "text/plain", visibility: "policy", sizeBytes: bytes.length, contentHash: sha256(bytes) };
  const reward = RewardReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardRelease.v1", id: "answer", revision: 1,
    name: "Answer", description: "Exact final text", implementation: { kind: "state", config: { fields: ["finalText"] } }, rawScore: { minimum: 0, maximum: 1 }, assets: [] }));
  const binding = RewardBindingSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardBinding.v1", id: "binding", revision: 1,
    sources: ["training", "evaluation"].map(role => ({ graderId: `answer-${role}`, reward: learningRef(reward), role, normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] })),
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }));
  const toolSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  const definition = TaskDefinitionSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskDefinition.v1", id: "definition", revision: 1,
    name: "File answer", description: "Reviewed Work", instructions: "Read the source and save answer.txt.", category: "tool_workflow", familyNamespace: "files",
    inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { finalText: { type: "string" } }, required: ["finalText"] },
    requiredOutputs: [{ path: "answer.txt", mediaType: "text/plain", maxBytes: 1000, schemaRef: null, metadata: {} }], rewardBinding: learningRef(binding), harness: null,
    execution: { environment: { protocolVersion: "openpond.environment.v1", kind: "work", entrypoint: "openpond-work-v1", stateful: true, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30000 },
      tools: ["work_read_file", "work_save_output"].map(name => ({ name, description: name, inputSchema: toolSchema, inputSchemaHash: contentHash(toolSchema), sideEffect: name === "work_read_file" ? "read" : "write", timeoutMs: 30000 })), capabilities: [],
      policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: binding.sources.map(source => source.graderId), connectedAppScopes: [] } } }));
  const source = LearningSourceSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningSource.v1", id: "source", revision: 1,
    name: "Reviewed source", kind: "direct", taskDefinition: learningRef(definition), enabled: true, allowedSplits: ["train"], mapping: null, adapterVersion: null }));
  const evidence = TaskEvidenceSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskEvidence.v1", id: "evidence", revision: 1, source: learningRef(source), supersedes: null, correctionFeedbackId: null, receivedAt: now,
    submission: { schemaVersion: "openpond.taskExample.v1", sourceId: source.id, idempotencyKey: "example", taskDefinition: learningRef(definition), exampleId: "example", attemptId: "attempt", occurredAt: now, familyKey: "family", split: "train", input: { prompt: "Answer" }, observedOutput: { finalText: "wrong" }, expected: { finalText: "correct" }, evaluatorContext: null, assets: [asset], provenance: { sourceRecordRef: null, mappingHash: null } } }));
  const grade = (output: Record<string, unknown>) => executeRewardBinding({ binding, rewards: [reward], task: taskRecordFromEvidence(evidence, definition), evidence: taskAttemptEvidence(evidence, output) });
  const decision = TaskAdmissionDecisionSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskAdmissionDecision.v1", id: "decision", revision: 1, evidence: learningRef(evidence), supersedes: null,
    actor: { kind: "human", id: "reviewer", policy: null }, evidenceValidity: "valid", taskAdmissibility: "approved", observedQuality: "failed", targetApproval: "approved", approvedTarget: { finalText: "correct" },
    grade: await grade({ finalText: "wrong" }), targetGrade: await grade({ finalText: "correct" }), note: "Reviewed", decidedAt: now }));
  const batch = sealTaskBatch({ id: "batch", definition, binding, rewards: [reward], purpose: "reward_training", evidence: [evidence], decisions: [decision], priorSplits: [], actorId: "reviewer", now });
  return { batch, definition, binding, rewards: [reward], evidence: [evidence], decisions: [decision], profileId: "profile", assetBytes: new Map([[asset.id, bytes]]) };
}

// Reviewed Work must retain its execution and output contract, and no missing,
// substituted or secret-bearing input may become an approved training bundle.
it("preserves reviewed Work contracts and verifies exact input bytes before preparation", async () => {
  const input = await reviewed();
  const result = prepareReviewedLearningBatch(input);
  const validation = validateTaskset(result.taskset); expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
  expect(result.taskset.environment).toMatchObject({ kind: "work", entrypoint: "openpond-work-v1", stateful: true, toolNames: ["work_read_file", "work_save_output"] });
  expect(result.release.tasks[0]!.requiredOutputs).toEqual(input.definition.requiredOutputs);
  expect(result.taskset.tasks[0]!.requiredOutputs).toMatchObject([{ path: "answer.txt", mediaType: "text/plain", maxBytes: 1000 }]);
  expect(result.taskset.metadata.tasksetOutputContract).toEqual({ mode: "artifacts", requiredOutputSource: "task.requiredOutputs" });
  const file = result.taskset.tasks[0]!.assets![0]!;
  expect(result.tasksetAssetBytes.get(file.artifactRef)).toEqual(input.assetBytes.get(file.id));
  expect(result.taskset.capabilities.compatibleMethods).toEqual(["grpo", "ppo"]);
  expect(() => prepareReviewedLearningBatch({ ...input, assetBytes: new Map() })).toThrow("missing or changed");
  expect(() => prepareReviewedLearningBatch({ ...input, assetBytes: new Map([[file.id, new TextEncoder().encode("changed")]]) })).toThrow("missing or changed");
  expect(() => prepareReviewedLearningBatch({ ...input, definition: { ...input.definition, requiredOutputs: [] } })).toThrow();
  const secret = await reviewed(new TextEncoder().encode("password=example-private-credential"));
  expect(() => prepareReviewedLearningBatch(secret)).toThrow("unresolved data findings");
});
