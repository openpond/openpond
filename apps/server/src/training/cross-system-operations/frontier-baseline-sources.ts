import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  type ChatModelRef,
  type CodexReasoningEffort,
  type TrainingSourceRef,
} from "@openpond/contracts";
import type { SqliteStore } from "../../store/store.js";
import { buildCrossSystemBootstrapDataset } from "./bootstrap-dataset.js";
import { crossSystemTrainingSourceMetadata } from "./baseline.js";
import { assertCrossSystemWorldSpecs, type CrossSystemWorldSpec } from "./fixture-baseline-sources.js";
import { runFrontierCrossSystemBaseline, type CrossSystemFrontierModelStream } from "./frontier-baseline.js";
import type { CrossSystemTask } from "./types.js";
import { generateCrossSystemTasks, generateCrossSystemWorld } from "./world-generator.js";

export async function recordFrontierBaselineSources(input: {
  store: SqliteStore;
  profileId: string;
  worldSpecs: CrossSystemWorldSpec[];
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  stream: CrossSystemFrontierModelStream;
  createEvidenceSource: (input: {
    profileId: string;
    task: CrossSystemTask;
    trajectory: Awaited<ReturnType<typeof runFrontierCrossSystemBaseline>>["trajectories"][number];
  }) => Promise<TrainingSourceRef>;
  approvedBy?: string;
  signal?: AbortSignal;
}) {
  assertCrossSystemWorldSpecs(input.worldSpecs);
  const worlds = input.worldSpecs.map(generateCrossSystemWorld);
  const tasks = worlds.flatMap(generateCrossSystemTasks);
  const baseline = await runFrontierCrossSystemBaseline({
    worlds,
    tasks,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    stream: input.stream,
    signal: input.signal,
  });
  const rawSources: TrainingSourceRef[] = [];
  for (let index = 0; index < baseline.trajectories.length; index += 1) {
    rawSources.push(await input.createEvidenceSource({
      profileId: input.profileId,
      task: baseline.tasks[index]!,
      trajectory: baseline.trajectories[index]!,
    }));
  }
  const approvedTrajectoryIds = baseline.results.flatMap((result) =>
    result.outcome === "correct" && result.rewardEligible ? [result.trajectoryId] : [],
  );
  const approvedAt = new Date().toISOString();
  const bootstrap = buildCrossSystemBootstrapDataset({
    tasks,
    trajectories: baseline.trajectories,
    results: baseline.results,
    approvedTrajectoryIds,
    approvedBy: input.approvedBy ?? "local_user_frontier_baseline",
    approvedAt,
  });
  const bootstrapByTrajectory = new Map(bootstrap.map((record) => [record.trajectoryId, record]));
  const sources: TrainingSourceRef[] = [];
  for (let index = 0; index < rawSources.length; index += 1) {
    const source = rawSources[index]!;
    const task = baseline.tasks[index]!;
    const trajectory = baseline.trajectories[index]!;
    const result = baseline.results[index]!;
    const bootstrapRecord = bootstrapByTrajectory.get(trajectory.id) ?? null;
    const generatedMetadata = crossSystemTrainingSourceMetadata({
      trajectory,
      result,
      report: baseline.report,
      approved: Boolean(bootstrapRecord),
    });
    sources.push(await input.store.upsertTrainingSource({
      ...source,
      clusterKey: trajectory.worldId,
      metadata: {
        ...source.metadata,
        ...generatedMetadata,
        frontierBaseline: true,
        crossSystemOperations: {
          ...(generatedMetadata.crossSystemOperations as Record<string, unknown>),
          generatorVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
          taskFamily: task.family,
          taskPrompt: task.prompt,
          expectedAnswer: task.expectedAnswer,
          trajectory,
          verifierResult: result,
          bootstrapMessages: bootstrapRecord?.messages ?? null,
        },
      },
    }));
  }
  return {
    schemaVersion: "openpond.crossSystemFrontierBaseline.v1" as const,
    report: baseline.report,
    trajectories: baseline.trajectories,
    results: baseline.results,
    sources,
    bootstrap,
  };
}
