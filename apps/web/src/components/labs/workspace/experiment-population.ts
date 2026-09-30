import type { ExperimentDefinition } from "openpond-sdk/experiments";
import type { DatasetRelease } from "./EvaluationSetupState";
/** Editing a non-cartesian retained population must not silently add target
 * calls. Only an explicit seed change creates a new task/seed cross product. */
export function experimentPopulation(input: { existing: ExperimentDefinition | null; release: DatasetRelease; taskIds: string[]; seedText: string; createReceiptId: (taskId: string, seed: string) => string }) {
  const seeds = [...new Set(input.seedText.split(/[\s,]+/).filter(Boolean))];
  if (!seeds.length || seeds.some(value => !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 2_147_483_647)) throw new Error("Enter integer environment seeds from 0 to 2147483647, separated by commas.");
  const tasks = new Set(input.taskIds);
  const previous = input.existing;
  const originalSeeds = previous ? [...new Set(previous.request.population.map(member => member.seed))] : [];
  if (previous?.request.policy.kind === "hosted_chat" && previous.request.taskset.id === input.release.id && previous.request.taskset.revision === input.release.revision && previous.request.taskset.contentHash === input.release.contentHash && JSON.stringify(seeds) === JSON.stringify(originalSeeds)) return previous.request.population.filter(member => tasks.has(member.taskId));
  if (tasks.size * seeds.length > 10_000) throw new Error("One Experiment can contain at most 10,000 task/seed members.");
  return [...tasks].flatMap(taskId => seeds.map(seed => ({ receiptId: input.createReceiptId(taskId, seed), taskId, seed, fixtureId: null })));
}
