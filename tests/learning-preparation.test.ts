import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createBuiltinTaskGradeExecutor, createTaskGradeWorker, learningRef, TaskAdmissionDecisionSchema } from "@openpond/evals/learning";
import { buildTrainingBundle } from "@openpond/training-sdk";
import { SqliteStore } from "../apps/server/src/store/store";
import { prepareLocalLearningBatch } from "../apps/server/src/training/learning-batch-preparation";
import { trainingExecutionBlockers } from "../apps/server/src/training/training-execution-readiness";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture } from "./helpers/learning-fixtures";
import { planFixture } from "./helpers/training-fixtures";

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
