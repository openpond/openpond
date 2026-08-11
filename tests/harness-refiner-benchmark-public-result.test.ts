import { readFile } from "node:fs/promises";
import path from "node:path";

import { contentHash } from "@openpond/harness";
import { describe, expect, test } from "vitest";

type Pair = {
  cohort: "adaptation" | "held_out";
  taskId: string;
  baselineTokens: number;
  refinedTokens: number;
  baselinePassed: boolean;
  refinedPassed: boolean;
};

type Aggregate = {
  baselineTokens: number;
  refinedTokens: number;
  lowerTaskCount: number;
  higherTaskCount: number;
  baselineQualityPassCount?: number;
  refinedQualityPassCount?: number;
  taskCount: number;
};

describe("Harness Refiner 08112026 public result", () => {
  test("is content-addressed and its published aggregates match all task pairs", async () => {
    const artifact = JSON.parse(await readFile(path.resolve(
      "benchmarks/harness-refiner/results/harness-refiner-08112026.json",
    ), "utf8")) as {
      contentHash: string;
      pairs: Pair[];
      aggregates: {
        adaptation: Aggregate;
        heldOut: Aggregate;
        relatedHeldOutMessages: Aggregate & { taskIds: string[] };
        allTasks: Aggregate;
      };
    };
    const { contentHash: expectedHash, ...core } = artifact;
    expect(contentHash(core)).toBe(expectedHash);
    expect(artifact.pairs).toHaveLength(20);
    expect(new Set(artifact.pairs.map((pair) => pair.taskId)).size).toBe(20);

    expectAggregate(
      artifact.pairs.filter((pair) => pair.cohort === "adaptation"),
      artifact.aggregates.adaptation,
    );
    expectAggregate(
      artifact.pairs.filter((pair) => pair.cohort === "held_out"),
      artifact.aggregates.heldOut,
    );
    expectAggregate(artifact.pairs, artifact.aggregates.allTasks);
    expectAggregate(
      artifact.pairs.filter((pair) =>
        artifact.aggregates.relatedHeldOutMessages.taskIds.includes(pair.taskId)
      ),
      artifact.aggregates.relatedHeldOutMessages,
    );
  });
});

function expectAggregate(pairs: Pair[], aggregate: Aggregate) {
  expect(aggregate).toMatchObject({
    baselineTokens: sum(pairs.map((pair) => pair.baselineTokens)),
    refinedTokens: sum(pairs.map((pair) => pair.refinedTokens)),
    lowerTaskCount: pairs.filter(
      (pair) => pair.refinedTokens < pair.baselineTokens,
    ).length,
    higherTaskCount: pairs.filter(
      (pair) => pair.refinedTokens > pair.baselineTokens,
    ).length,
    taskCount: pairs.length,
  });
  if (aggregate.baselineQualityPassCount !== undefined) {
    expect(aggregate.baselineQualityPassCount).toBe(
      pairs.filter((pair) => pair.baselinePassed).length,
    );
  }
  if (aggregate.refinedQualityPassCount !== undefined) {
    expect(aggregate.refinedQualityPassCount).toBe(
      pairs.filter((pair) => pair.refinedPassed).length,
    );
  }
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
