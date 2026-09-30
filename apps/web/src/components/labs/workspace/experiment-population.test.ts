import { expect, it } from "vitest";
import type { ExperimentDefinition } from "openpond-sdk/experiments";
import { experimentPopulation } from "./experiment-population";
// A routine name/budget edit must not expand two retained members into four
// model calls just because two seeds were used on different tasks originally.
it("preserves exact existing task/seed pairs and bounds explicit seed expansion", () => {
  const release = { id: "dataset-a", revision: 1, contentHash: "a".repeat(64) };
  const members = [{ taskId: "task-a", seed: "0", fixtureId: null, receiptId: "receipt-a" }, { taskId: "task-b", seed: "1", fixtureId: null, receiptId: "receipt-b" }];
  const existing = { request: { policy: { kind: "hosted_chat" }, taskset: release, population: members } } as unknown as ExperimentDefinition;
  const input = { existing, release, taskIds: ["task-a", "task-b"], seedText: "0, 1", createReceiptId: (task: string, seed: string) => `${task}:${seed}` };
  expect(experimentPopulation(input)).toEqual(members);
  expect(experimentPopulation({ ...input, taskIds: ["task-b"] })).toEqual([members[1]]);
  expect(experimentPopulation({ ...input, seedText: "2, 3" }).map(({ taskId, seed }) => [taskId, seed])).toEqual([["task-a", "2"], ["task-a", "3"], ["task-b", "2"], ["task-b", "3"]]);
  expect(() => experimentPopulation({ ...input, seedText: "-1" })).toThrow("integer");
  expect(() => experimentPopulation({ ...input, existing: null, taskIds: Array.from({ length: 10_000 }, (_, index) => `task-${index}`) })).toThrow("10,000");
});
