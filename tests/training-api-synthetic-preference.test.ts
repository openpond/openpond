import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GradeResultSchema, type Taskset } from "../packages/contracts/src/index.js";
import { createTrainingApi } from "../apps/server/src/training/training-api.js";
import { tasksetFixture } from "./helpers/training-fixtures.js";

const HASH = "a".repeat(64);

function fixtureTaskset(): Taskset {
  const source = tasksetFixture({ ready: true });
  const train = source.tasks.find((task) => task.split === "train")!;
  return {
    ...source,
    tasks: [
      train,
      {
        ...train,
        id: "task_validation",
        clusterKey: "cluster_validation",
        split: "validation",
      },
    ],
  };
}

describe("synthetic preference collection API", () => {
  it("routes structured C0 attempts through grades and canonical comparison receipts before D0", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-c0-api-"));
    const taskset = fixtureTaskset();
    const artifacts = new Map<string, any[]>();
    const assignments: any[] = [];
    const receipts: any[] = [];
    const datasets: any[] = [];
    const store = {
      getTaskset: async () => taskset,
      saveTaskAttempt: async (attempt: any) => attempt,
      saveTaskAttemptArtifact: async (artifact: any) => {
        artifacts.set(artifact.attemptId, [artifact]);
        return artifact;
      },
      listTaskAttemptArtifacts: async ({ attemptId }: { attemptId: string }) => artifacts.get(attemptId) ?? [],
    };
    const preferenceComparisons = {
      createAssignment: async (assignment: any) => {
        assignments.push(assignment);
        return { id: assignment.id };
      },
      submitFixtureReceipt: async (receipt: any) => {
        receipts.push(receipt);
        return receipt;
      },
      materializePreferenceDataset: async (dataset: any) => {
        datasets.push(dataset);
        return { id: dataset.id };
      },
    };
    const api = createTrainingApi({
      store: store as never,
      storeDir: directory,
      taskCreator: {} as never,
      taskMiner: {} as never,
      evaluation: {
        grade: async ({ attempt }: { attempt: any }) => GradeResultSchema.parse({
          schemaVersion: "openpond.gradeResult.v1",
          id: `grade-${attempt.id}`,
          attemptId: attempt.id,
          graderSetHash: HASH,
          score: 1,
          passed: true,
          components: [{
            graderId: "expected_output",
            graderVersion: "1",
            score: 1,
            passed: true,
            hardGate: true,
            rewardEligible: true,
            feedback: null,
            evidenceRefs: [],
            judge: null,
            calibrationStatus: "not_applicable",
          }],
          failureClass: null,
          feedback: [],
          rewardEligible: true,
          createdAt: "2026-08-25T12:00:00.000Z",
        }),
      } as never,
      training: {} as never,
      chatSearch: {} as never,
      datasetArtifacts: {} as never,
      datasetImports: {} as never,
      benchmarkTasksets: { releaseForTaskset: async () => null } as never,
      preferenceComparisons: preferenceComparisons as never,
    });
    const groups = [
      ["task_train", "reward_train"],
      ["task_validation", "reward_validation"],
    ].map(([scenarioId, partition], groupIndex) => ({
      scenarioId,
      partition,
      candidates: ["love", "like", "reject", "reject"].map((label, candidateIndex) => ({
        id: `candidate-${groupIndex}-${candidateIndex}`,
        output: JSON.stringify({ selection: `${groupIndex}-${candidateIndex}` }),
        label,
      })),
    }));
    try {
      const result = await api.request("materialize_synthetic_preference_collection", {
        tasksetId: taskset.id,
        actorKey: "fixture-author",
        comparisonReleaseId: "comparison-release-fixture",
        preferenceDatasetId: "dataset-d0",
        preferenceDatasetRevision: 1,
        collection: {
          schemaVersion: "openpond.syntheticCollectionRun.v1",
          id: "collection-c0",
          fixtureRelease: { id: "fixture-c0", contentHash: HASH },
          labelerRelease: { id: "labeler-c0", contentHash: HASH },
          groups,
        },
      }) as any;
      expect(result.collection.attempts).toHaveLength(8);
      expect(assignments).toHaveLength(2);
      expect(assignments.every((assignment) => assignment.candidates.length === 4)).toBe(true);
      expect(assignments.flatMap((assignment) => assignment.candidates).every((candidate) => candidate.visibleArtifactIds.length === 0)).toBe(true);
      expect(receipts).toHaveLength(2);
      expect(datasets).toEqual([expect.objectContaining({
        authority: "synthetic_fixture",
        groups: [
          expect.objectContaining({ partition: "reward_train" }),
          expect.objectContaining({ partition: "reward_validation" }),
        ],
      })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
