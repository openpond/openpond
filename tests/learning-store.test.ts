import { describe, expect, test } from "vitest";
import {
  createBuiltinTaskGradeExecutor, createTaskGradeWorker, learningRef, sealLearningContent,
  TaskAdmissionDecisionSchema, TaskEvidenceSchema, TaskFeedbackSchema, taskBatchPackageMetadata,
  type TaskGradeExecutor,
} from "@openpond/evals/learning";
import { TasksetReleaseSchema, policyTaskView } from "@openpond/evals/tasksets";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture, learningNow } from "./helpers/learning-fixtures";
import { attemptFixture, withTrainingStore } from "./helpers/training-fixtures";
import { createLocalTaskGradeExecutor } from "../apps/server/src/training/learning-grade-executor";
import { prepareImportedTasksetPackage } from "../apps/server/src/training/taskset-package-import";
import { cacheTasksetPackage, materializeImportedTasksetPackage } from "../apps/server/src/training/taskset-package-files";
import { createTasksetEvaluationVerifier } from "../apps/server/src/training/evaluation-custom-verifier";
import { resolveTasksetTrainingReward } from "../apps/server/src/training/taskset-reward-binding";
import { prepareLocalLearningBatch } from "../apps/server/src/training/learning-batch-preparation";
import { exportLocalModelTasksetPackage } from "../apps/server/src/training/model-taskset-package-export";
import { createModelProjectSaveRequest, HostedModelProjectTrainingSetupSchema, ModelProjectSchema } from "openpond-sdk/model-projects";
import { createTasksetPackage, decodeTasksetPackageFile, tasksetPackageRewardBinding, OpenPondTasksetPackageClient, TasksetPackageModelConfigurationSchema, type TasksetPackagePublication } from "openpond-sdk/taskset-packages";

const withStore = (run: (store: SqliteLearningStore, home: string) => Promise<void>) => withTempDirectory("openpond-learning-", async (home) => {
  const store = new SqliteLearningStore(home);
  try { await run(store, home); } finally { await store.close(); }
});

describe("durable task intake and admission", () => {
  // A Model package must retain the reviewed batch's authoring graph, not
  // merely enough task rows to execute its current grader.
  test("exports an attached approved batch with its exact definition and Reward binding", async () => withTrainingStore(async ({ store, directory }) => {
    const fixture = await learningFixture(store.learningRepository(), { verifierSource: `export function verify({ output, expectedOutput, evaluatorContext }) {
      const passed = output.answer === expectedOutput.answer && evaluatorContext?.private === "never show to policy";
      return { score: passed ? 1 : 0, passed, feedback: "Checked private context", evidenceRefs: [] };
    }` });
    const evidence = await fixture.submit();
    const worker = createTaskGradeWorker(store.learningRepository(), createLocalTaskGradeExecutor(store.learningRepository()), { workerId: "package-proof" });
    const observed = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence)).id);
    const target = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence, "proposed_target", { answer: "correct" })).id);
    const decision = TaskAdmissionDecisionSchema.parse((await fixture.command({ action: "review", evidence: learningRef(evidence), expectedRevision: 0, disposition: "approved", targetApproval: "approved", approvedTarget: { answer: "correct" }, observedGradeId: observed.id, targetGradeId: target.id, note: "Reviewed package target" })).resources[0]);
    await fixture.command({ action: "seal_batch", batchId: "package-batch", taskDefinition: learningRef(fixture.definition), purpose: "supervised_training", evidence: [learningRef(evidence)], decisions: [learningRef(decision)] });
    const taskset = await prepareLocalLearningBatch(store, directory, { profileId: learningContext.scope, batchId: "package-batch" });
    const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "batch-model", profileId: learningContext.scope, name: "Reviewed batch Model", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: { tasksetRef: learningRef(taskset) } }, 0));
    const value = await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: learningContext.scope, modelId: model.id });
    // A source Model must survive its first hosted receipt even though generated
    // private context files exist in the package, not its authored directory.
    await cacheTasksetPackage(directory, value);
    const linked = await store.saveModelProjectHosting(model, ModelProjectSchema.parse({ ...model, hosted: {
      schemaVersion: "openpond.hostedModelProjectLink.v1", apiOrigin: "https://packages.example.test", teamId: "team",
      projectId: "hosted-batch-model", portableProjectId: model.id, revision: 1, etag: "a".repeat(64),
      syncedSourceRevision: model.revision, syncedAt: learningNow, tasksets: [{ localTasksetId: taskset.id,
        localTasksetHash: taskset.contentHash, releaseId: value.taskset.id, releaseRevision: value.taskset.revision,
        releaseHash: value.taskset.contentHash, packageHash: value.contentHash, hostedTasksetId: "hosted-taskset", syncedAt: learningNow }],
    } }));
    expect(await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: model.profileId, modelId: model.id })).toEqual(value);
    const renamedSource = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: linked.id,
      profileId: linked.profileId, name: "Renamed source batch", objective: linked.objective, defaultBaseModel: null,
      defaultDestinationId: null, trainingSetup: linked.trainingSetup }, linked.revision));
    expect(renamedSource.trainingSetup).toEqual(linked.trainingSetup);
    const metadata = taskBatchPackageMetadata(value.taskset);
    expect(metadata.definition).toEqual(fixture.definition);
    expect(metadata.binding).toEqual(fixture.binding);
    expect(tasksetPackageRewardBinding(value)).toEqual(fixture.binding);
    const configuration = TasksetPackageModelConfigurationSchema.parse({ portableProjectId: model.id, name: model.name,
      objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: {}, sourceRevision: 1, sourceUpdatedAt: learningNow });
    const project = { ...configuration, id: "hosted-batch-model", teamId: "team", revision: 1, etag: "a".repeat(64), createdAt: learningNow, updatedAt: learningNow,
      trainingSetup: HostedModelProjectTrainingSetupSchema.parse({ tasksetRef: learningRef(value.taskset), rewardBindingRef: learningRef(fixture.binding) }) };
    let receivedProject = project;
    const client = new OpenPondTasksetPackageClient({ baseUrl: "https://packages.example.test", apiKey: "test", teamId: "team", fetch: async () => Response.json({
      schemaVersion: "openpond.tasksetPackageReceipt.v1", teamId: "team", modelProjectId: model.id, operationId: "publish-batch",
      taskset: learningRef(value.taskset), packageHash: value.contentHash, hostedTasksetId: "hosted-taskset", projectEtag: project.etag, project: receivedProject,
    }) });
    const publication: TasksetPackagePublication = { schemaVersion: "openpond.tasksetPackagePublication.v1", modelProjectId: model.id,
      operationId: "publish-batch", expectedProjectEtag: null, name: model.name, description: "", buildIntent: "demonstrations", methodHint: "sft", package: value, modelConfiguration: configuration };
    expect((await client.publish(publication)).project?.trainingSetup.rewardBindingRef).toEqual(learningRef(fixture.binding));
    receivedProject = { ...project, trainingSetup: { ...project.trainingSetup, rewardBindingRef: null } };
    await expect(client.publish(publication)).rejects.toMatchObject({ code: "package_receipt_mismatch" });
    expect(metadata.admissions[0]?.decision).toEqual(learningRef(decision));
    expect(value.learningResources?.evidence).toEqual([evidence]);
    expect(value.learningResources?.decisions).toEqual([decision]);
    const context = value.files.find(file => file.asset.id === value.taskset.tasks[0]?.privilegedContextRef)!;
    expect(context.asset.visibility).toBe("host_private");
    expect(JSON.parse(new TextDecoder().decode(decodeTasksetPackageFile(context)))).toEqual(evidence.submission.evaluatorContext);
    expect(JSON.stringify(policyTaskView(value.taskset.tasks[0]!))).not.toContain("never show");
    const { contentHash: _hash, ...content } = value;
    expect(() => createTasksetPackage({ ...content, learningResources: { ...value.learningResources!, decisions: [] } })).toThrow();
    expect(() => createTasksetPackage({ ...content, files: value.files.filter(file => file !== context) })).toThrow("private context is missing");
    const { contentHash: _releaseHash, ...releaseContent } = value.taskset;
    const changedPolicy = sealLearningContent({ ...releaseContent, policy: { ...releaseContent.policy, connectedAppScopes: ["unexpected-scope"] } });
    expect(() => createTasksetPackage({ ...content, taskset: changedPolicy })).toThrow("execution differs from its reviewed task definition");
    const changedOutputs = sealLearningContent({ ...releaseContent, tasks: releaseContent.tasks.map(task => ({ ...task,
      requiredOutputs: [{ path: "result.json", mediaType: "application/json", schemaRef: null, maxBytes: null, metadata: {} }],
    })) });
    expect(() => createTasksetPackage({ ...content, taskset: changedOutputs })).toThrow("rows differ from their reviewed evidence");
    await withTrainingStore(async ({ store: destination, directory: destinationDirectory }) => {
      const imported = prepareImportedTasksetPackage({ package: value, profileId: "fresh-profile", name: "Imported batch", createdAt: learningNow });
      await materializeImportedTasksetPackage({ home: destinationDirectory, ...imported });
      await destination.upsertTaskset(imported.taskset);
      const importedModel = await destination.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "imported-model", profileId: "fresh-profile", name: "Imported batch Model", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: { tasksetRef: learningRef(imported.taskset), rewardBindingRef: learningRef(fixture.binding) } }, 0));
      const renamed = await destination.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: importedModel.id, profileId: importedModel.profileId,
        name: "Renamed imported batch", objective: importedModel.objective, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: importedModel.trainingSetup }, importedModel.revision));
      expect(renamed.trainingSetup).toEqual(importedModel.trainingSetup);
      const changedReward = await createModelProjectSaveRequest({ id: renamed.id, profileId: renamed.profileId, name: renamed.name,
        objective: renamed.objective, defaultBaseModel: null, defaultDestinationId: null,
        trainingSetup: { ...renamed.trainingSetup, rewardBindingRef: { ...learningRef(fixture.binding), id: "different-binding" } } }, renamed.revision);
      await expect(destination.saveModelProjectConfiguration(changedReward)).rejects.toMatchObject({ code: "model_batch_reward_review_required" });
      expect(await destination.getModelProject(renamed.id)).toEqual(renamed);
      expect(await exportLocalModelTasksetPackage({ store: destination, storeDir: destinationDirectory, profileId: "fresh-profile", modelId: importedModel.id })).toEqual(value);
      const run = await createTasksetEvaluationVerifier({ store: destination, storeDir: destinationDirectory }, imported.taskset);
      const grader = imported.taskset.graders[0]!;
      if (!run || grader.kind !== "custom_verifier") throw new Error("Imported custom Reward is unavailable.");
      const task = imported.taskset.tasks[0]!;
      expect(await run({ grader, task, attempt: attemptFixture({ output: { answer: "correct" } }) })).toMatchObject({ passed: true, score: 1 });
      expect(await run({ grader, task, attempt: attemptFixture({ output: { answer: "wrong" } }) })).toMatchObject({ passed: false, score: 0 });
      expect(await resolveTasksetTrainingReward(destination, imported.taskset, destinationDirectory)).toMatchObject({
        rewardExecution: { binding: fixture.binding, rewards: [fixture.reward] }, verifierAssets: value.learningResources!.assets,
      });
      expect(await destination.learningRepository().transaction("fresh-profile", tx => tx.get("source", fixture.source.id))).toBeNull();
      expect(await destination.learningRepository().transaction("fresh-profile", tx => tx.get("asset", value.learningResources!.assets[0]!.id))).toBeNull();
    });
  }));

  // Regression: one failed source reference must not leave a half-published
  // task format, and a safe retry must receive the original complete receipt.
  test("publishes dependent resources atomically and retries the exact publication", async () => withStore(async (store) => {
    const fixture = await learningFixture(store.learningRepository());
    const { contentHash: _rewardHash, ...reward } = fixture.reward;
    const { contentHash: _sourceHash, ...source } = fixture.source;
    const command = { action: "publish_resources", operationId: "publish-format-atomic", resources: [
      { kind: "reward", expectedRevision: 0, content: { ...reward, id: "atomic-reward" } },
      { kind: "source", expectedRevision: 0, content: { ...source, id: "atomic-source", taskDefinition: { ...source.taskDefinition, id: "missing-definition" } } },
    ] };
    await expect(fixture.command(command)).rejects.toThrow("learning_resource_not_found");
    await expect(fixture.service.get(learningContext, "reward", "atomic-reward")).rejects.toThrow("learning_resource_not_found");
    command.resources[1]!.content = { ...source, id: "atomic-source" };
    const receipt = await fixture.command(command);
    expect(await fixture.command(command)).toEqual(receipt);
    expect(receipt.resources).toHaveLength(2);
  }));

  // Regression: a failed observed output must not be confused with a reviewed SFT target.
  test("seals a graded correction while preserving failed output, private context, and immutable retry receipts", async () => withStore(async (store, home) => {
    const repository = store.learningRepository();
    const fixture = await learningFixture(repository);
    const evidence = await fixture.submit();
    expect(await fixture.submit()).toEqual(evidence);
    await expect(fixture.submit({ input: { question: "changed" } })).rejects.toThrow("learning_idempotency_conflict");
    const worker = createTaskGradeWorker(repository, createBuiltinTaskGradeExecutor(), { workerId: "worker-a" });
    const observed = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence)).id);
    const target = await worker.run(learningContext.scope, (await fixture.queueGrade(evidence, "proposed_target", { answer: "correct" })).id);
    expect(observed.composition?.training).toMatchObject({ status: "scored", passed: false, score: 0 });
    expect(target.composition?.training).toMatchObject({ status: "scored", passed: true, score: 1 });
    const review = { action: "review", evidence: learningRef(evidence), expectedRevision: 0, disposition: "approved", targetApproval: "approved", approvedTarget: { answer: "correct" }, observedGradeId: observed.id, targetGradeId: target.id, note: "Verified correction" };
    await expect(fixture.command({ ...review, approvedTarget: { answer: "ungraded replacement" } })).rejects.toThrow("task_grade_identity_mismatch");
    const decision = TaskAdmissionDecisionSchema.parse((await fixture.command(review)).resources[0]);
    expect(decision.observedQuality).toBe("failed");
    const feedback = TaskFeedbackSchema.parse((await fixture.command({ action: "submit_feedback", feedback: { schemaVersion: "openpond.taskFeedback.v1", sourceId: fixture.source.id, idempotencyKey: "target-feedback-1", exampleId: evidence.submission.exampleId, attemptId: evidence.submission.attemptId, expectedEvidenceHash: evidence.contentHash, occurredAt: learningNow, kind: "target_correction", value: { answer: "correct" }, note: "Human correction" } })).resources[0]);
    await expect(fixture.command({ action: "resolve_feedback", feedbackId: feedback.id, expectedRevision: feedback.revision, disposition: "applied", decision: null, note: "No linked review" })).rejects.toThrow("task_feedback_decision_required");
    const resolved = TaskFeedbackSchema.parse((await fixture.command({ action: "resolve_feedback", feedbackId: feedback.id, expectedRevision: feedback.revision, disposition: "applied", decision: learningRef(decision), note: "Target passed and was approved" })).resources[0]);
    expect(resolved).toMatchObject({ status: "applied", review: { actorId: learningContext.actor.id, decision: learningRef(decision) } });
    const sealed = await fixture.command({ action: "seal_batch", operationId: "seal-1", batchId: "batch-1", taskDefinition: learningRef(fixture.definition), purpose: "supervised_training", evidence: [learningRef(evidence)], decisions: [learningRef(decision)] });
    const release = TasksetReleaseSchema.parse(sealed.resources[1]);
    expect(taskBatchPackageMetadata(release).admissions[0]?.supervisedTarget).toEqual({ answer: "correct" });
    expect(JSON.stringify(policyTaskView(release.tasks[0]!))).not.toContain("correct");
    expect(JSON.stringify(policyTaskView(release.tasks[0]!))).not.toContain("never show");
    expect((await fixture.service.get(learningContext, "evidence", evidence.id)).submission.observedOutput).toEqual({ answer: "wrong" });
    await store.close();
    const restarted = new SqliteLearningStore(home);
    try {
      const page = await restarted.learningRepository().transaction(learningContext.scope, (tx) => tx.list("package", { limit: 1 }));
      expect(page.items).toEqual([release]);
      expect(await restarted.learningRepository().transaction("other-profile", (tx) => tx.get("evidence", evidence.id))).toBeNull();
    } finally { await restarted.close(); }
  }));

  // Regression: feedback arriving before an example must survive and corrections cannot rewrite history.
  test("applies out-of-order feedback as a new revision and rolls back stale concurrent edits", async () => withStore(async (store) => {
    const fixture = await learningFixture(store.learningRepository());
    const feedback = TaskFeedbackSchema.parse((await fixture.command({ action: "submit_feedback", feedback: { schemaVersion: "openpond.taskFeedback.v1", sourceId: fixture.source.id, idempotencyKey: "feedback-1", exampleId: fixture.example.exampleId, attemptId: fixture.example.attemptId, expectedEvidenceHash: null, occurredAt: learningNow, kind: "ground_truth_correction", value: { answer: "corrected truth" }, note: "Verified source" } })).resources[0]);
    expect(feedback.status).toBe("pending_example");
    const evidence = await fixture.submit();
    const results = await Promise.allSettled([1, 2].map(() => fixture.command({ action: "apply_correction", feedbackId: feedback.id, evidence: learningRef(evidence) })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const revised = await fixture.service.get(learningContext, "evidence", evidence.id);
    expect(revised.revision).toBe(2);
    expect(revised.submission.expected).toEqual({ answer: "corrected truth" });
    expect(revised.submission.observedOutput).toEqual(evidence.submission.observedOutput);
    expect(await fixture.service.get(learningContext, "evidence", evidence.id, 1)).toEqual(evidence);
    expect(await fixture.submit()).toEqual(evidence);
    await expect(fixture.queueGrade(evidence)).rejects.toThrow("task_evidence_revision_stale");
  }));

  // Regression: renaming a family must not let identical held-out inputs enter training.
  test("enforces split isolation transactionally across batches and source retries", async () => withStore(async (store) => {
    const fixture = await learningFixture(store.learningRepository());
    const evidence = await fixture.submit({ split: "frozen_eval" });
    const approve = async (item: ReturnType<typeof TaskEvidenceSchema.parse>) => TaskAdmissionDecisionSchema.parse((await fixture.command({ action: "review", evidence: learningRef(item), expectedRevision: 0, disposition: "approved", targetApproval: "not_required", approvedTarget: null, observedGradeId: null, targetGradeId: null, note: "Task input reviewed" })).resources[0]);
    const decision = await approve(evidence);
    await fixture.command({ action: "seal_batch", batchId: "held-out", taskDefinition: learningRef(fixture.definition), purpose: "evaluation", evidence: [learningRef(evidence)], decisions: [learningRef(decision)] });
    const duplicate = await fixture.submit({ idempotencyKey: "example-2", exampleId: "example-2", familyKey: "different-family" });
    const secondDecision = await approve(duplicate);
    await expect(fixture.command({ action: "seal_batch", batchId: "contaminated", taskDefinition: learningRef(fixture.definition), purpose: "reward_training", evidence: [learningRef(duplicate)], decisions: [learningRef(secondDecision)] })).rejects.toThrow("task_family_split_contamination");
    expect((await fixture.service.list(learningContext, "batch")).items).toHaveLength(1);
    expect(await store.learningRepository().transaction(learningContext.scope, (tx) => tx.familySplit("answers", "family", "different-family"))).toBeNull();
  }));

  // Regression: duplicate workers or a UI cancel must not create duplicate compute or false terminal receipts.
  test("claims grading once and waits for execution-owner cancellation confirmation", async () => withStore(async (store) => {
    const repository = store.learningRepository();
    const fixture = await learningFixture(repository);
    const evidence = await fixture.submit();
    const queued = await fixture.queueGrade(evidence);
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    let executions = 0;
    let confirmed = false;
    const executor: TaskGradeExecutor = {
      execute: async ({ signal }) => {
        executions++;
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
      cancel: async () => confirmed,
    };
    let clock = Date.parse(learningNow);
    const worker = createTaskGradeWorker(repository, executor, { workerId: "worker-a", now: () => new Date(clock).toISOString() });
    const second = createTaskGradeWorker(repository, executor, { workerId: "worker-b", now: () => new Date(clock).toISOString() });
    const active = worker.run(learningContext.scope, queued.id);
    await hasStarted;
    const running = await second.run(learningContext.scope, queued.id);
    expect(executions).toBe(1);
    expect(running.status).toBe("running");
    await fixture.command({ action: "cancel_grade", gradeId: queued.id, expectedRevision: running.revision });
    worker.requestCancellation(learningContext.scope, queued.id);
    expect((await active).status).toBe("cancelling");
    confirmed = true;
    clock += 6_000;
    expect((await second.run(learningContext.scope, queued.id)).status).toBe("cancelled");
    expect(executions).toBe(1);
  }));
});
