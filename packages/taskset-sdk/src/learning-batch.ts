import { TasksetSchema, type GeneratedTaskFile, type GraderFixture, type LearningSignalInventory, type TasksetSourceRef } from "@openpond/contracts";
import { compileTaskBatch, learningRef, taskBatchPackageMetadata, verifyLearningTextAsset, type LearningTextAsset, type RewardBinding, type RewardComposition, type RewardRelease, type TaskAdmissionDecision, type TaskBatch, type TaskDefinition, type TaskEvidence } from "@openpond/evals";
import { computeTasksetHash } from "./validation.js";
import { contentHash } from "./hashing.js";
import { learningVerifierModule, projectLearningBatchGraders } from "./learning-graders.js";

/** Private product projection of an already sealed public batch. The public
 * compiler rechecks every evidence/decision snapshot before adaptation. */
export function materializeLearningBatchTaskset(input: {
  batch: TaskBatch; definition: TaskDefinition; binding: RewardBinding; rewards: RewardRelease[];
  evidence: TaskEvidence[]; decisions: TaskAdmissionDecision[]; profileId: string;
  source: TasksetSourceRef;
  assets?: LearningTextAsset[];
}) {
  const release = compileTaskBatch(input);
  const metadata = taskBatchPackageMetadata(release);
  if (release.environment.kind !== "text" || release.tools.length || release.tasks.some((task) => task.artifactRefs.length)) throw new Error("This learning batch requires an environment or asset adapter before local training preparation.");
  const sourceId = input.source.id;
  const signals: LearningSignalInventory = { demonstrations: [], preferences: [], corrections: [], feedback: [], rewards: [], labels: [] };
  const fixtures: GraderFixture[] = [];
  for (const admission of metadata.admissions) {
    const evidence = input.evidence.find((item) => item.id === admission.evidence.id)!;
    const decision = input.decisions.find((item) => item.id === admission.decision.id)!;
    if (input.batch.purpose === "reward_training" && decision.grade?.training.status === "scored") signals.rewards.push({
      id: `reward-${admission.taskId}`, taskId: admission.taskId, kind: "reward", task: input.definition.instructions,
      rules: [{ id: input.binding.id, points: 1, condition: "Execute the released Reward binding with its declared normalization, weights and gates." }],
      otherwisePoints: 0, executable: true, approved: true, confidence: 1, sourceRefs: [sourceId], artifactRef: input.binding.id,
      metadata: { rewardBinding: learningRef(input.binding), evidence: admission.evidence, decision: admission.decision },
    });
    if (admission.supervisedTarget !== null) signals.demonstrations.push({ kind: "demonstration", id: `demo-${admission.taskId}`, taskId: admission.taskId, sourceRefs: [sourceId], artifactRef: admission.decision.id, approved: true, confidence: 1, prompt: null, response: JSON.stringify(admission.supervisedTarget), metadata: { evidence: admission.evidence, decision: admission.decision, targetGradeHash: decision.targetGrade?.contentHash } });
    for (const [kind, output, grade] of [["observed", evidence.submission.observedOutput, decision.grade], ["target", decision.approvedTarget, decision.targetGrade]] as const) {
      const outcome = fixtureOutcome(grade);
      if (output === null || outcome === null) continue;
      fixtures.push({ id: `fixture-${kind}-${admission.taskId}`, taskId: admission.taskId, label: outcome.passed ? "positive" : "negative", output, infrastructureError: null, expectedPassed: outcome.passed, expectedRewardEligible: outcome.rewardEligible, metadata: { gradeReceiptHash: grade!.contentHash, evidence: admission.evidence, decision: admission.decision } });
    }
  }
  if (!fixtures.length) throw new Error("Grade at least one reviewed response before preparing this batch. Grader fixtures must come from actual receipts.");
  const graders = projectLearningBatchGraders(input.binding, input.rewards, input.assets);
  const generatedFiles: GeneratedTaskFile[] = [];
  for (const grader of release.graders) {
    if (grader.kind !== "custom_verifier") continue;
    const asset = input.assets?.find((asset) => asset.id === grader.verifierRef.id);
    if (!asset) throw new Error(`Reward ${grader.id} is missing its immutable verifier source.`);
    const module = learningVerifierModule(grader.verifierRef.contentHash);
    if (!generatedFiles.some((file) => file.path === module)) generatedFiles.push({ path: module, role: "verifier", content: verifyLearningTextAsset(asset, grader.verifierRef) });
  }
  const taskset = TasksetSchema.parse({
    schemaVersion: "openpond.taskset.v1", id: `learning-${contentHash([input.profileId, input.batch.contentHash]).slice(0, 40)}`, revision: 1,
    profileId: input.profileId, profileRelease: null, createImproveRunId: null, name: `${input.definition.name} · ${input.batch.examples.length} approved examples`, objective: input.definition.instructions,
    purpose: "general", benchmark: null, status: "needs_review", sourceRefs: [input.source], datasetArtifact: null,
    policy: release.policy,
    environment: { protocolVersion: "openpond.taskEnvironment.v1", kind: "chat", entrypoint: "openpond.text.v1", stateful: false, deterministicSeeds: release.environment.deterministicSeeds, toolNames: [], lifecycle: ["create", "reset", "step", "grade", "cleanup"], defaultTimeoutMs: release.environment.defaultTimeoutMs, networkPolicy: release.environment.networkPolicy, metadata: { portableEnvironment: release.environment } },
    capabilities: { schemaVersion: "openpond.tasksetCapabilities.v1", taskKind: "chat", supportedSignals: signals.demonstrations.length ? ["demonstration", "reward"] : ["reward"], compatibleMethods: input.batch.purpose === "supervised_training" ? ["sft"] : input.batch.purpose === "reward_training" ? ["grpo", "ppo"] : ["none"], rewardKinds: ["deterministic"], requiresTools: false, requiresState: false, requiresPrivilegedGrading: true, environmentPlacements: ["local", "remote"], exportable: true, portabilityBlockers: [] },
    tasks: release.tasks.map(({ artifactRefs: _assets, ...task }) => ({ ...task, schemaVersion: "openpond.taskData.v1", sourceRefs: [sourceId], metadata: { admission: metadata.admissions.find((entry) => entry.taskId === task.id), exampleOrigin: input.evidence.find((evidence) => evidence.id === task.id)?.correctionFeedbackId ? "corrected" : "extracted" } })),
    graders, graderFixtures: fixtures, learningSignals: signals,
    authoringProvenance: { schemaVersion: "openpond.taskAuthoringProvenance.v1", model: null, modelConfig: {}, skillHash: contentHash("openpond-learning-batch-v1"), promptTemplateVersion: "learning-batch-v1", buildIntent: input.batch.purpose === "supervised_training" ? "demonstrations" : "verifiable_reward", buildSpecification: null, evidenceHashes: input.batch.examples.map((entry) => entry.evidence.contentHash), tasksetSdkVersion: "learning-batch-v1", sourceCommit: null, repairHistory: [], createdAt: input.batch.sealedAt },
    readiness: null, contentHash: "00000000", createdAt: input.batch.sealedAt, updatedAt: input.batch.sealedAt,
    metadata: { learning: metadata, learningRelease: learningRef(release), trainingMethod: input.batch.purpose === "supervised_training" ? "sft" : input.batch.purpose === "reward_training" ? "grpo" : "none", tasksetOutputContract: { kind: "structured", schema: input.definition.outputSchema } },
  });
  return { taskset: TasksetSchema.parse({ ...taskset, contentHash: computeTasksetHash(taskset) }), release, generatedFiles };
}

function fixtureOutcome(grade: RewardComposition | null) {
  if (!grade) return null;
  const outcome = grade.training.status === "not_configured" ? grade.evaluation : grade.training;
  if (outcome.status !== "scored") return null;
  return { passed: outcome.passed === true, rewardEligible: grade.training.status === "scored" };
}
