import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  type ChatModelRef,
  type CrossSystemWorldSpec,
  type TrainingSourceRef,
} from "@openpond/contracts";
import type { SqliteStore } from "../../store/store.js";
import { buildCrossSystemBootstrapDataset } from "./bootstrap-dataset.js";
import {
  crossSystemTrainingSourceMetadata,
  runScriptedCrossSystemBaseline,
} from "./baseline.js";
import type { CrossSystemSplit } from "./types.js";
import { generateCrossSystemTasks, generateCrossSystemWorld } from "./world-generator.js";

/**
 * Records the deterministic, networkless baseline used by the desktop proof.
 * The HTTP boundary that calls this helper is available only in scripted harness mode;
 * production frontier traces must arrive through ordinary completed chat evidence.
 */
export async function recordFixtureBaselineSources(input: {
  store: SqliteStore;
  profileId: string;
  sourceIds: string[];
  worldSpecs: CrossSystemWorldSpec[];
  model: ChatModelRef;
  approvedBy?: string;
}) {
  if (input.sourceIds.length === 0) throw new Error("Fixture baseline requires selected training sources.");
  assertCrossSystemWorldSpecs(input.worldSpecs);
  const worlds = input.worldSpecs.map(generateCrossSystemWorld);
  const tasks = worlds.flatMap(generateCrossSystemTasks);
  const selectedTasks = tasks.filter((task) => task.phrasingVariant === 0);
  if (selectedTasks.length !== input.sourceIds.length) {
    throw new Error(`Fixture baseline requires exactly ${selectedTasks.length} sources for the selected worlds.`);
  }
  const sources = await Promise.all(input.sourceIds.map((sourceId) => input.store.getTrainingSource(sourceId)));
  if (sources.some((source) => !source || source.profileId !== input.profileId)) {
    throw new Error("Fixture baseline sources must exist in the selected profile.");
  }
  const typedSources = sources as TrainingSourceRef[];
  const baseline = await runScriptedCrossSystemBaseline({ worlds, tasks, model: input.model });
  const approvedTrajectoryIds = baseline.results.flatMap((result) =>
    result.outcome === "correct" && result.rewardEligible ? [result.trajectoryId] : [],
  );
  const approvedAt = new Date().toISOString();
  const bootstrap = buildCrossSystemBootstrapDataset({
    tasks,
    trajectories: baseline.trajectories,
    results: baseline.results,
    approvedTrajectoryIds,
    approvedBy: input.approvedBy ?? "desktop_harness_user",
    approvedAt,
  });
  const bootstrapByTrajectory = new Map(bootstrap.map((record) => [record.trajectoryId, record]));

  const updatedSources: TrainingSourceRef[] = [];
  for (let index = 0; index < typedSources.length; index += 1) {
    const source = typedSources[index]!;
    const trajectory = baseline.trajectories[index]!;
    const result = baseline.results[index]!;
    const task = selectedTasks[index]!;
    const record = bootstrapByTrajectory.get(trajectory.id) ?? null;
    const generatedMetadata = crossSystemTrainingSourceMetadata({
      trajectory,
      result,
      report: baseline.report,
      approved: Boolean(record),
    });
    const crossSystemOperations = {
      ...(generatedMetadata.crossSystemOperations as Record<string, unknown>),
      generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
      taskFamily: task.family,
      taskPrompt: task.prompt,
      expectedAnswer: task.expectedAnswer,
      trajectory,
      verifierResult: result,
      bootstrapMessages: record?.messages ?? null,
    };
    updatedSources.push(await input.store.upsertTrainingSource({
      ...source,
      clusterKey: trajectory.worldId,
      metadata: {
        ...source.metadata,
        ...generatedMetadata,
        crossSystemOperations,
        fixtureBaseline: true,
      },
    }));
  }

  return {
    schemaVersion: "openpond.crossSystemFixtureBaseline.v1" as const,
    report: baseline.report,
    trajectories: baseline.trajectories,
    results: baseline.results,
    sources: updatedSources,
    bootstrap,
  };
}

export function assertCrossSystemWorldSpecs(specs: CrossSystemWorldSpec[]): void {
  if (specs.length < 3) throw new Error("Fixture baseline requires train, validation, and frozen-evaluation worlds.");
  const keys = new Set<string>();
  const splits = new Set<CrossSystemSplit>();
  for (const spec of specs) {
    if (!Number.isInteger(spec.seed) || spec.seed < 0) throw new Error("World seeds must be non-negative integers.");
    const key = `${spec.split}:${spec.seed}`;
    if (keys.has(key)) throw new Error(`Duplicate fixture world ${key}.`);
    keys.add(key);
    splits.add(spec.split);
  }
  for (const split of ["train", "validation", "frozen_eval"] as const) {
    if (!splits.has(split)) throw new Error(`Fixture baseline is missing the ${split} split.`);
  }
}
