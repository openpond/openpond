import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createBuiltinTaskGradeExecutor, createTaskGradeWorker, createLearningTextAsset, learningRef, TaskAdmissionDecisionSchema, TaskDefinitionSchema, LearningSourceSchema, TaskBatchPackageMetadataSchema } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
import { buildTrainingBundle } from "@openpond/training-sdk";
import { gradeAttempt } from "@openpond/taskset-sdk";
import { SqliteStore } from "../apps/server/src/store/store";
import { prepareLocalLearningBatch } from "../apps/server/src/training/learning-batch-preparation";
import { trainingExecutionBlockers } from "../apps/server/src/training/training-execution-readiness";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture } from "./helpers/learning-fixtures";
import { attemptFixture, planFixture } from "./helpers/training-fixtures";
import { createLocalTaskGradeExecutor } from "../apps/server/src/training/learning-grade-executor";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import { compileDesktopHarnessContext, projectDesktopCanonicalReceipts } from "../apps/server/src/training/portable-evals-adapter";

// Regression: preparing a reviewed example must train on the independently
// approved target while retaining expected/observed values only for evaluation.
test("prepares an immutable local Taskset and exports only the approved SFT response", async () => withTempDirectory("learning-prepare-", async (home) => {
  const store = new SqliteStore(home);
  try {
    const fixture = await learningFixture(store.learningRepository());
    const evidence = await fixture.submit({ expected: { answer: "correct", rationale: "private verifier explanation" } });
    const approvedTarget = { answer: "correct", rationale: "reviewed response for training" };
    const worker = createTaskGradeWorker(store.learningRepository(), createBuiltinTaskGradeExecutor(), { workerId: "preparation-worker" });
    const observed = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence)).id);
    const target = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence, "proposed_target", approvedTarget)).id);
    const decision = TaskAdmissionDecisionSchema.parse((await fixture.command({ action: "review", evidence: learningRef(evidence), expectedRevision: 0, disposition: "approved", targetApproval: "approved", approvedTarget, observedGradeId: observed.id, targetGradeId: target.id, note: "Checked both task and target" })).resources[0]);
    await fixture.command({ action: "seal_batch", batchId: "preparation-batch", taskDefinition: learningRef(fixture.definition), purpose: "supervised_training", evidence: [learningRef(evidence)], decisions: [learningRef(decision)] });
    const request = { profileId: learningContext.scope, batchId: "preparation-batch" };
    const taskset = await prepareLocalLearningBatch(store, home, request);
    expect(await prepareLocalLearningBatch(store, home, request)).toEqual(taskset);
    expect(taskset.tasks[0]!.expectedOutput).toEqual(evidence.submission.expected);
    expect(taskset.graderFixtures.map((fixture) => fixture.expectedPassed)).toEqual([false, true]);
    expect(trainingExecutionBlockers(taskset)).toEqual([]);
    const directory = path.join(home, "prepared-bundle");
    await buildTrainingBundle({ taskset, plan: planFixture(taskset), directory });
    const content = await readFile(path.join(directory, "data/train.jsonl"), "utf8");
    expect(JSON.parse(content).expectedOutput).toEqual(approvedTarget);
    expect(JSON.parse(content).policyVisibleContext).toEqual({ instructions: fixture.definition.instructions });
    expect(content).not.toContain("private verifier explanation");
    expect(content).not.toContain("wrong");
    expect(content).not.toContain("never show");
    await expect(prepareLocalLearningBatch(store, home, { ...request, profileId: "other-profile" })).rejects.toThrow("learning_resource_not_found");
  } finally { await store.close(); }
}));

// Review, prepared evaluation and canonical optimizer receipts must execute the
// same code and composer, without exposing private context in training data.
test("retains private code, source roles and normalization through prepared batch execution", async () => withTempDirectory("learning-composer-", async (home) => {
  const store = new SqliteStore(home);
  try {
    const fixture = await learningFixture(store.learningRepository());
    const code = createLearningTextAsset({ path: "checks/private-cost.js", mediaType: "text/javascript", visibility: "verifier",
      text: 'export function verify(value) { if (value.evaluatorContext.private !== "never show to policy") throw new Error("Private context missing"); return {score: 0, passed: true, feedback: "Private cost check passed"}; }',
    });
    const { contentHash: _assetHash, ...assetContent } = code;
    const codeReward = RewardReleaseSchema.parse((await fixture.command({ action: "publish_resources", resources: [
      { kind: "asset", expectedRevision: 0, content: assetContent },
      { kind: "reward", expectedRevision: 0, content: { schemaVersion: "openpond.rewardRelease.v1", id: "private-cost", revision: 1,
        name: "Private cost", description: "Lower scores are better", rawScore: { minimum: 0, maximum: 1 }, assets: [code.asset],
        implementation: { kind: "custom_verifier", verifierRef: code.asset, exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" } } },
    ] })).resources[1]);
    const source = fixture.binding.sources[0]!;
    const binding = RewardBindingSchema.parse((await fixture.command({ action: "publish", kind: "binding", expectedRevision: 0,
      content: { schemaVersion: "openpond.rewardBinding.v1", id: "prepared-composer", revision: 1,
        aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required", sources: [
          { ...source, hardGate: false },
          { ...source, graderId: "private-cost", reward: learningRef(codeReward), hardGate: false, weight: 3,
            normalization: { kind: "linear", minimum: 0, maximum: 1, direction: "lower" } },
          { ...source, graderId: "evaluation-only", role: "evaluation", weight: 100 },
        ] } })).resources[0]);
    const { contentHash: _definitionHash, ...definitionContent } = fixture.definition;
    const definition = TaskDefinitionSchema.parse((await fixture.command({ action: "publish", kind: "definition", expectedRevision: 0,
      content: { ...definitionContent, id: "prepared-definition", rewardBinding: learningRef(binding),
        execution: { ...definitionContent.execution, policy: { ...definitionContent.execution.policy, hiddenGraderRefs: binding.sources.map((source) => source.graderId) } } } })).resources[0]);
    const { contentHash: _sourceHash, ...sourceContent } = fixture.source;
    const intake = LearningSourceSchema.parse((await fixture.command({ action: "publish", kind: "source", expectedRevision: 0,
      content: { ...sourceContent, id: "prepared-source", taskDefinition: learningRef(definition) } })).resources[0]);
    const evidence = await fixture.submit({ sourceId: intake.id, taskDefinition: learningRef(definition) });
    const worker = createTaskGradeWorker(store.learningRepository(), createLocalTaskGradeExecutor(store.learningRepository()), { workerId: "prepared-composer" });
    const observed = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence)).id);
    const targetOutput = { answer: "correct" };
    const target = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence, "proposed_target", targetOutput)).id);
    expect(observed.composition?.training.score).toBe(0.75);
    expect(observed.composition?.evaluation.score).toBe(0);
    expect(target.composition?.training.score).toBe(1);
    const decision = TaskAdmissionDecisionSchema.parse((await fixture.command({ action: "review", evidence: learningRef(evidence), expectedRevision: 0,
      disposition: "approved", targetApproval: "approved", approvedTarget: targetOutput, observedGradeId: observed.id, targetGradeId: target.id,
      note: "Verified private source and target" })).resources[0]);
    await fixture.command({ action: "seal_batch", batchId: "composed-batch", taskDefinition: learningRef(definition), purpose: "supervised_training",
      evidence: [learningRef(evidence)], decisions: [learningRef(decision)] });
    const taskset = await prepareLocalLearningBatch(store, home, { profileId: learningContext.scope, batchId: "composed-batch" });
    const privateGrader = taskset.graders.find((grader) => grader.kind === "custom_verifier")!;
    if (privateGrader.kind !== "custom_verifier") throw new Error("Prepared code grader is missing.");
    expect(await readFile(path.join(home, "training", "tasksets", taskset.id, privateGrader.module), "utf8")).toBe(code.text);
    const changed = createLearningTextAsset({ path: code.asset.path, mediaType: code.asset.mediaType, visibility: code.asset.visibility,
      text: 'export function verify() { return {score: 1, passed: false, feedback: "New code"}; }' });
    const { contentHash: _changedHash, ...changedContent } = changed;
    const { contentHash: _rewardHash, ...rewardContent } = codeReward;
    await fixture.command({ action: "publish_resources", resources: [
      { kind: "asset", expectedRevision: 0, content: changedContent },
      { kind: "reward", expectedRevision: 1, content: { ...rewardContent, revision: 2, assets: [changed.asset],
        implementation: { ...codeReward.implementation, verifierRef: changed.asset } } },
    ] });
    const task = taskset.tasks[0]!;
    const attempt = attemptFixture({ tasksetId: taskset.id, taskId: task.id, split: "train", output: evidence.submission.observedOutput!,
      metadata: { execution: "post_training_evaluation_tool_loop", verifierOutcome: "correct", verifierReward: 1, verifierRewardEligible: true } });
    const evaluation = createTaskEvaluationService({ store, storeDir: home });
    const grade = await evaluation.grade({ tasksetId: taskset.id, taskId: task.id, attempt });
    expect(grade).toMatchObject({ score: 0.75, rewardEligible: true, rewardComposition: { training: { score: 0.75 }, evaluation: { score: 0 } } });
    expect(grade.rewardComposition?.results.find((result) => result.graderId === "private-cost")).toMatchObject({ rawScore: 0, normalizedScore: 1, reward: learningRef(codeReward) });
    const context = compileDesktopHarnessContext({ taskset, model: { providerId: "openpond", modelId: "fixture" } });
    const canonical = projectDesktopCanonicalReceipts({ context, attempt, grade, artifacts: [] });
    expect(canonical.rewardReceipt.reward).toBe(0.75);
    expect(canonical.rewardReceipt.components.find((component) => component.verifierId === "private-cost")).toMatchObject({ rawScore: 0, normalizedScore: 1 });
    expect(canonical.rewardReceipt.metadata.rewardComposition).toEqual(grade.rewardComposition);
    const learning = TaskBatchPackageMetadataSchema.parse(taskset.metadata.learning);
    await expect(gradeAttempt({ task, attempt, graders: taskset.graders })).rejects.toThrow("immutable public Reward binding");
    expect(await gradeAttempt({ task, attempt, graders: taskset.graders, learning })).toMatchObject({ score: null, rewardEligible: false,
      rewardComposition: { training: { status: "unscorable" } } });
    const directory = path.join(home, "composed-export");
    await buildTrainingBundle({ taskset, plan: planFixture(taskset), directory });
    const rows = await readFile(path.join(directory, "data/train.jsonl"), "utf8");
    expect(JSON.parse(rows).expectedOutput).toEqual(targetOutput);
    expect(rows).not.toContain("never show to policy");
    expect(rows).not.toContain("Private cost check");
    expect(await evaluation.auditFixtures({ tasksetId: taskset.id })).toMatchObject({ passed: true });
  } finally { await store.close(); }
}));
