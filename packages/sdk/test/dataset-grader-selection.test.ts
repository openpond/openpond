import { expect, it } from "vitest";
import { canonicalDatasetGraderSelection, groupDatasetGraders } from "../src/dataset-grader-selection.js";

// Training/evaluation aliases of one Reward must not duplicate a score, while
// genuinely different releases must never overwrite the same feedback field.
it("groups exact released aliases, retains provenance and saved mappings, and rejects conflicting selections", () => {
  const release = { id: "reward-a", revision: 2, contentHash: "a".repeat(64) };
  const training = { id: "training", version: "1", contentHash: "b".repeat(64), feedbackKey: "accuracy", release };
  const evaluation = { ...training, id: "evaluation", contentHash: "c".repeat(64) };
  expect(groupDatasetGraders([training, evaluation])).toMatchObject([{ grader: training, aliases: [training, evaluation] }]);
  const mappings = [{ source: "output", target: "answer" }];
  expect(canonicalDatasetGraderSelection([{ ...evaluation, mappings }, { ...training, mappings }])).toEqual([{ ...evaluation, mappings }]);
  expect(canonicalDatasetGraderSelection([training, evaluation])).toEqual([training]);
  expect(() => canonicalDatasetGraderSelection([{ ...evaluation, mappings }, { ...training, mappings: [] }])).toThrow("different field mappings");
  for (const different of [
    { ...evaluation, release: { ...release, revision: 3 } },
    { ...evaluation, release: { ...release, contentHash: "d".repeat(64) } },
    { ...evaluation, release: { ...release, id: "reward-b" } },
    { ...evaluation, release: null },
  ]) expect(() => canonicalDatasetGraderSelection([training, different])).toThrow("Different selected grader releases");
  expect(canonicalDatasetGraderSelection([{ ...evaluation, release: { ...release, revision: 3 } }])).toHaveLength(1);
  expect(training.release).toEqual(release);
});
