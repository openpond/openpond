import { expect, it } from "vitest";
import { TrainingEvaluationSourceSchema, assertTrainingEvaluationIsolation, trainingEvaluationSourceRef } from "../src/training.js";

const train = [{ id: "train-1", clusterKey: "family-train", split: "train" }];
const source = {
  schemaVersion: "openpond.trainingEvaluationSource.v1",
  taskset: { id: "held-out", revision: 2, contentHash: "a".repeat(64) },
  tasks: [{ id: "eval-1", clusterKey: "family-eval", split: "validation", input: { prompt: "Question" }, expectedOutput: { text: "private answer" } }],
  assets: [{ path: "expected.json", sha256: "b".repeat(64), sizeBytes: 2, encoding: "base64", content: "e30=" }],
};

// A retained source cannot conceal a different private answer, asset, or release.
it("pins the exact held-out release, full task bytes and private assets", async () => {
  const ref = await trainingEvaluationSourceRef(source);
  expect(ref).toEqual(await trainingEvaluationSourceRef(structuredClone(source)));
  for (const changed of [
    { ...source, taskset: { ...source.taskset, revision: 3 } },
    { ...source, tasks: [{ ...source.tasks[0], expectedOutput: { text: "changed" } }] },
    { ...source, assets: [{ ...source.assets[0], content: "W10=" }] },
  ]) expect((await trainingEvaluationSourceRef(changed)).dataset).not.toEqual(ref.dataset);
});

// Same-family examples and held-out rows must never leak into optimization.
it("rejects split leakage, duplicate tasks and shared families", () => {
  expect(() => assertTrainingEvaluationIsolation(train, source.tasks)).not.toThrow();
  for (const task of [
    { ...source.tasks[0], split: "train" },
    { ...source.tasks[0], id: train[0].id },
    { ...source.tasks[0], clusterKey: train[0].clusterKey },
  ]) expect(() => assertTrainingEvaluationIsolation(train, [task])).toThrow();
  expect(() => assertTrainingEvaluationIsolation([{ ...train[0], split: "validation" }], source.tasks)).toThrow();
  expect(() => assertTrainingEvaluationIsolation([...train, ...train], source.tasks)).toThrow();
  expect(() => TrainingEvaluationSourceSchema.parse({ ...source, tasks: [...source.tasks, ...source.tasks] })).toThrow();
});
