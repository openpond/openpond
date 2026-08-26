import os from "node:os";
import path from "node:path";

import { gradeAttempt, publishTasksetDraft, validateTaskset } from "@openpond/taskset-sdk";

import { SqliteStore } from "../apps/server/src/store/store.js";

const draftId = process.argv[2];
const storeDirectory = path.resolve(
  process.argv[3] ?? path.join(os.homedir(), ".openpond", "openpond-app"),
);
if (!draftId) throw new Error("Usage: verify-structured-selection-draft <draft-id> [store-directory]");

const store = new SqliteStore(storeDirectory);
try {
  const draft = await store.getTasksetDraft(draftId);
  if (!draft) throw new Error(`Draft ${draftId} was not found.`);
  const taskset = publishTasksetDraft({ draft, now: "2026-08-24T23:00:00.000Z" });
  const fixture = draft.graderFixtures.find((item) => item.label === "positive");
  if (!fixture) throw new Error("The positive fixture is missing.");
  const task = taskset.tasks.find((item) => item.id === fixture.taskId);
  if (!task) throw new Error("The fixture task is missing.");
  const grade = await gradeAttempt({
    task,
    attempt: {
      schemaVersion: "openpond.taskAttempt.v1",
      id: `${draft.id}-proof-attempt`,
      tasksetId: taskset.id,
      taskId: task.id,
      split: task.split,
      attempt: 0,
      seed: 17,
      modelRef: null,
      startedAt: "2026-08-24T23:00:00.000Z",
      completedAt: "2026-08-24T23:00:01.000Z",
      output: fixture.output,
      runtimeEventRefs: [],
      artifactRefs: [],
      privilegedOutcomeRef: null,
      infrastructureError: null,
      costUsd: null,
      latencyMs: 1_000,
      userInterventions: 0,
      metadata: {},
    },
    graders: taskset.graders,
  });
  process.stdout.write(JSON.stringify({
    name: draft.name,
    revision: draft.revision,
    status: draft.status,
    splits: Object.fromEntries(["train", "validation", "frozen_eval"].map((split) => [
      split,
      draft.tasks.filter((task) => task.split === split).length,
    ])),
    minimumSamples: draft.review.minimumSamples,
    fixtureCount: draft.graderFixtures.length,
    grade: { passed: grade.passed, score: grade.score, feedback: grade.feedback },
    tasksetValid: validateTaskset(taskset).valid,
    materializedTasksetId: taskset.id,
  }, null, 2) + "\n");
} finally {
  await store.close();
}
