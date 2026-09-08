import { expect, test } from "vitest";
import { createTaskGradeWorker, createLearningTextAsset, learningRef, TaskAdmissionDecisionSchema, TaskGradeRunSchema, RewardBindingSchema } from "openpond-sdk/learning";
import { createModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { ModelBatchReviewRequestSchema } from "openpond-sdk/taskset-packages";
import { learningFixture, learningContext, learningNow } from "./helpers/learning-fixtures";
import { withTrainingStore } from "./helpers/training-fixtures";
import { createLocalTaskGradeExecutor } from "../apps/server/src/training/learning-grade-executor";
import { prepareLocalLearningBatch } from "../apps/server/src/training/learning-batch-preparation";
import { exportLocalModelTasksetPackage } from "../apps/server/src/training/model-taskset-package-export";
import { beginLocalModelBatchReview } from "../apps/server/src/training/model-batch-review";
import { prepareImportedTasksetPackage } from "../apps/server/src/training/taskset-package-import";
import { materializeImportedTasksetPackage } from "../apps/server/src/training/taskset-package-files";

// Changing a reviewed Model must require new grades/decisions, survive retries,
// and retain the original package and the other Model's selected batch.
test("revises a Model batch through new evidence and grading before attachment", async () => withTrainingStore(async ({ store, directory }) => {
  const fixture = await learningFixture(store.learningRepository());
  const evidence = await fixture.submit();
  const worker = createTaskGradeWorker(store.learningRepository(), createLocalTaskGradeExecutor(store.learningRepository()), { workerId: "review-test" });
  const observed = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence)).id);
  const target = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence, "proposed_target", { answer: "correct" })).id);
  const review = (ref: typeof evidence, observedId: string | null, targetId: string, answer: string) => fixture.command({
    action: "review", evidence: learningRef(ref), expectedRevision: 0, disposition: "approved", targetApproval: "approved",
    approvedTarget: { answer }, observedGradeId: observedId, targetGradeId: targetId, note: "Reviewed target",
  });
  const decision = TaskAdmissionDecisionSchema.parse((await review(evidence, observed.id, target.id, "correct")).resources[0]);
  const { contentHash: _sourceHash, ...sourceContent } = fixture.source;
  await fixture.command({ action: "publish", kind: "source", expectedRevision: 0, content: { ...sourceContent, id: "second-source" } });
  const second = await fixture.submit({ sourceId: "second-source", familyKey: "second-family" });
  const secondTarget = await worker.run(learningContext.scope, (await fixture.queueGrade(second, "proposed_target", { answer: "correct" })).id);
  const secondDecision = TaskAdmissionDecisionSchema.parse((await review(second, null, secondTarget.id, "correct")).resources[0]);
  await fixture.command({ action: "seal_batch", batchId: "original-batch", taskDefinition: learningRef(fixture.definition),
    purpose: "supervised_training", evidence: [learningRef(evidence), learningRef(second)], decisions: [learningRef(decision), learningRef(secondDecision)] });
  const taskset = await prepareLocalLearningBatch(store, directory, { profileId: learningContext.scope, batchId: "original-batch" });
  const setup = { profileId: learningContext.scope, name: "Reviewed Model", objective: null, defaultBaseModel: null, defaultDestinationId: null,
    trainingSetup: { tasksetRef: learningRef(taskset), rewardBindingRef: learningRef(fixture.binding) } };
  const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...setup, id: "model-a" }, 0));
  const other = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...setup, id: "model-b" }, 0));
  const original = await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: model.profileId, modelId: model.id });
  const asset = createLearningTextAsset({ text: `export function verify({output, expectedOutput, evaluatorContext}) {
    const passed = output.answer === expectedOutput.answer.toUpperCase() && evaluatorContext?.private === "never show to policy";
    return {score: passed ? 1 : 0, passed, feedback: "Checked revised answer", evidenceRefs: []};
  }`, path: "reward/revised.js", mediaType: "text/javascript", visibility: "host_private" });
  const { contentHash: _assetHash, ...assetContent } = asset;
  await fixture.command({ action: "publish", kind: "asset", expectedRevision: 0, content: assetContent });
  const { contentHash: _rewardHash, ...rewardContent } = fixture.reward;
  const reward = (await fixture.command({ action: "publish", kind: "reward", expectedRevision: 0, content: { ...rewardContent,
    id: "uppercase", assets: [asset.asset], implementation: { kind: "custom_verifier", verifierRef: asset.asset, exportName: "verify", timeoutMs: 5_000, networkPolicy: "none" } } })).resources[0]!;
  if (!("contentHash" in reward)) throw new Error("Expected immutable Reward");
  const { contentHash: _bindingHash, ...bindingContent } = fixture.binding;
  const binding = RewardBindingSchema.parse((await fixture.command({ action: "publish", kind: "binding", expectedRevision: 0, content: {
    ...bindingContent, id: "uppercase-binding", sources: bindingContent.sources.map(source => ({ ...source, reward: learningRef(reward) })),
  } })).resources[0]);
  const request = ModelBatchReviewRequestSchema.parse({ schemaVersion: "openpond.modelBatchReviewRequest.v1", operationId: "revise-1", modelId: model.id,
    expectedModelRevision: model.revision, tasksetRef: learningRef(taskset), rewardBindingRef: learningRef(binding), definition: {},
    examples: [{ evidence: learningRef(evidence), input: { question: "Revised task input" } }],
  });
  const begin = (value = request, profileId = model.profileId) => beginLocalModelBatchReview({ store, storeDir: directory, profileId, request: value });
  await expect(begin({ ...request, expectedModelRevision: 99 })).rejects.toMatchObject({ code: "model_revision_conflict" });
  expect((await fixture.service.list(learningContext, "source")).items).toHaveLength(2);
  const started = await begin();
  expect(await begin()).toEqual(started);
  expect(started.evidence).toHaveLength(2);
  expect(new Set(started.evidence.map(item => item.id)).size).toBe(2);
  expect(new Set(started.evidence.map(item => item.submission.attemptId)).size).toBe(2);
  expect(started.source.reviewOrigin).toMatchObject({ modelId: model.id, packageHash: original.contentHash, batch: learningRef(original.learningResources!.batch) });
  const revised = started.evidence.find(item => item.supersedes?.id === evidence.id)!;
  expect(revised).toMatchObject({ supersedes: learningRef(evidence), submission: { input: { question: "Revised task input" }, observedOutput: null } });
  expect(started.proposals[0]).toMatchObject({ status: "pending_review", submission: { value: { answer: "correct" } }, review: null });
  expect(await store.getModelProject(model.id)).toEqual(model);
  await expect(review(revised, observed.id, target.id, "correct")).rejects.toThrow("task_grade_not_applicable");
  const grade = async (answer: string) => {
    const queued = TaskGradeRunSchema.parse((await fixture.command({ action: "queue_grade", evidence: learningRef(revised), target: "proposed_target", proposedTarget: { answer } })).resources[0]);
    return worker.run(model.profileId, queued.id);
  };
  const failed = await grade("correct");
  expect(failed.composition?.training.passed).toBe(false);
  await expect(review(revised, null, failed.id, "correct")).rejects.toThrow("supervised_target_checks_not_passed");
  expect((await fixture.service.list(learningContext, "decision", { parentId: revised.id })).items).toHaveLength(0);
  const passed = await grade("CORRECT");
  expect(passed.composition?.training.passed).toBe(true);
  const accepted = TaskAdmissionDecisionSchema.parse((await review(revised, null, passed.id, "CORRECT")).resources[0]);
  await fixture.command({ action: "seal_batch", batchId: "revised-batch", taskDefinition: revised.submission.taskDefinition,
    purpose: "supervised_training", evidence: [learningRef(revised)], decisions: [learningRef(accepted)] });
  const prepared = await prepareLocalLearningBatch(store, directory, { profileId: model.profileId, batchId: "revised-batch" });
  const renamed = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...setup, id: model.id, name: "Renamed during review" }, model.revision));
  expect(await begin()).toEqual(started);
  const attachment = { ...setup, id: model.id, name: renamed.name, trainingSetup: { tasksetRef: learningRef(prepared) } };
  await expect(store.saveModelProjectConfiguration(await createModelProjectSaveRequest(attachment, model.revision))).rejects.toMatchObject({ code: "model_revision_conflict" });
  await store.saveModelProjectConfiguration(await createModelProjectSaveRequest(attachment, renamed.revision));
  expect(await store.getModelProject(other.id)).toEqual(other);
  expect(await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: model.profileId, modelId: other.id })).toEqual(original);
  const changed = await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: model.profileId, modelId: model.id });
  expect(changed.learningResources!.sources[0]!.reviewOrigin).toEqual(started.source.reviewOrigin);
  expect(changed.learningResources!.decisions[0]!.approvedTarget).toEqual({ answer: "CORRECT" });
  await expect(begin({ ...request, examples: [] })).rejects.toMatchObject({ code: "learning_idempotency_conflict" });
  await expect(begin(request, "foreign")).rejects.toMatchObject({ code: "model_not_found" });
  await withTrainingStore(async ({ store: destination, directory: destinationDirectory }) => {
    const imported = prepareImportedTasksetPackage({ package: original, profileId: "fresh", name: "Imported batch", createdAt: learningNow });
    await materializeImportedTasksetPackage({ home: destinationDirectory, ...imported });
    await destination.upsertTaskset(imported.taskset);
    const importedModel = await destination.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...setup, id: "imported-model", profileId: "fresh",
      trainingSetup: { tasksetRef: learningRef(imported.taskset) } }, 0));
    const fresh = await beginLocalModelBatchReview({ store: destination, storeDir: destinationDirectory, profileId: "fresh", request: {
      ...request, modelId: importedModel.id, expectedModelRevision: importedModel.revision, tasksetRef: learningRef(imported.taskset), rewardBindingRef: null, examples: [],
    } });
    expect(fresh.evidence).toHaveLength(2);
    expect(await destination.learningRepository().transaction("fresh", tx => tx.get("source", fixture.source.id))).toBeNull();
    expect(await destination.learningRepository().transaction("fresh", tx => tx.get("decision", decision.id))).toBeNull();
    expect(await destination.getModelProject(importedModel.id)).toEqual(importedModel);
  });
}));
