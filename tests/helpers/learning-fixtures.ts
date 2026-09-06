import {
  createLearningService, learningRef, LearningSourceSchema, TaskDefinitionSchema,
  TaskEvidenceSchema, TaskGradeRunSchema, type LearningRepository, type TaskExampleSubmission,
} from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";

export const learningContext = { scope: "profile-a", actor: { id: "reviewer-a", role: "reviewer" as const } };
export const learningNow = "2026-09-06T12:00:00.000Z";

export async function learningFixture(repository: LearningRepository) {
  const service = createLearningService(repository, { now: () => learningNow });
  let serial = 0;
  const command = (input: Record<string, unknown>) => service.command(learningContext, { operationId: `operation-${++serial}`, ...input });
  const reward = RewardReleaseSchema.parse((await command({
    action: "publish", kind: "reward", expectedRevision: 0,
    content: { schemaVersion: "openpond.rewardRelease.v1", id: "match", revision: 1, name: "Exact answer", description: "Compare structured answer", implementation: { kind: "state", config: { fields: ["answer"] } }, rawScore: { minimum: 0, maximum: 1 }, assets: [] },
  })).resources[0]);
  const binding = RewardBindingSchema.parse((await command({
    action: "publish", kind: "binding", expectedRevision: 0,
    content: { schemaVersion: "openpond.rewardBinding.v1", id: "binding", revision: 1, sources: [{ graderId: "answer", reward: learningRef(reward), role: "training", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" },
  })).resources[0]);
  const definition = TaskDefinitionSchema.parse((await command({
    action: "publish", kind: "definition", expectedRevision: 0,
    content: {
      schemaVersion: "openpond.taskDefinition.v1", id: "definition", revision: 1, name: "Extract answer", description: "Structured answer task", instructions: "Return the answer as JSON.", category: "structured", familyNamespace: "answers",
      inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
      outputSchema: { type: "object", properties: { answer: { type: "string" }, rationale: { type: "string" } }, required: ["answer"], additionalProperties: false },
      rewardBinding: learningRef(binding), harness: null,
      execution: { policy: { policyVisibleFields: ["input", "policyVisibleContext"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: ["answer"], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] },
    },
  })).resources[0]);
  const source = LearningSourceSchema.parse((await command({
    action: "publish", kind: "source", expectedRevision: 0,
    content: { schemaVersion: "openpond.learningSource.v1", id: "source", revision: 1, name: "Direct examples", kind: "direct", taskDefinition: learningRef(definition), enabled: true, allowedSplits: ["train", "frozen_eval"], mapping: null, adapterVersion: null },
  })).resources[0]);
  const example: TaskExampleSubmission = {
    schemaVersion: "openpond.taskExample.v1", sourceId: source.id, idempotencyKey: "example-1", taskDefinition: learningRef(definition), exampleId: "example-1", attemptId: "attempt-1", occurredAt: learningNow,
    familyKey: "family-1", split: "train", input: { question: "What is the answer?" }, observedOutput: { answer: "wrong" }, expected: { answer: "correct" }, evaluatorContext: { private: "never show to policy" }, assets: [], provenance: { sourceRecordRef: null, mappingHash: null },
  };
  const submit = async (overrides: Partial<TaskExampleSubmission> = {}) => TaskEvidenceSchema.parse((await command({ action: "submit_example", example: { ...example, ...overrides } })).resources[0]);
  const queueGrade = async (evidence: ReturnType<typeof TaskEvidenceSchema.parse>, target: "observed" | "proposed_target" = "observed", proposedTarget: Record<string, unknown> | null = null) =>
    TaskGradeRunSchema.parse((await command({ action: "queue_grade", evidence: learningRef(evidence), target, proposedTarget })).resources[0]);
  return { service, command, definition, source, reward, binding, example, submit, queueGrade };
}
