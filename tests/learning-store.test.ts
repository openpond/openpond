import { describe, expect, test } from "vitest";
import {
  createBuiltinTaskGradeExecutor, createTaskGradeWorker, learningRef,
  TaskAdmissionDecisionSchema, TaskEvidenceSchema, TaskFeedbackSchema, taskBatchPackageMetadata,
  type TaskGradeExecutor,
} from "@openpond/evals/learning";
import { TasksetReleaseSchema, policyTaskView } from "@openpond/evals/tasksets";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture, learningNow } from "./helpers/learning-fixtures";

const withStore = (run: (store: SqliteLearningStore, home: string) => Promise<void>) => withTempDirectory("openpond-learning-", async (home) => {
  const store = new SqliteLearningStore(home);
  try { await run(store, home); } finally { await store.close(); }
});

describe("durable task intake and admission", () => {
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
