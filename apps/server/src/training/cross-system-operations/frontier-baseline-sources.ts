import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemWorldSpec,
  type TrainingSourceRef,
} from "@openpond/contracts";
import type { SqliteStore } from "../../store/store.js";
import { buildCrossSystemBootstrapDataset } from "./bootstrap-dataset.js";
import { crossSystemTrainingSourceMetadata } from "./baseline.js";
import { assertCrossSystemWorldSpecs } from "./fixture-baseline-sources.js";
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
  onTaskStarted?: Parameters<typeof runFrontierCrossSystemBaseline>[0]["onTaskStarted"];
  onTaskRecorded?: (input: {
    index: number;
    total: number;
    task: CrossSystemTask;
    trajectory: Awaited<ReturnType<typeof runFrontierCrossSystemBaseline>>["trajectories"][number];
    result: Awaited<ReturnType<typeof runFrontierCrossSystemBaseline>>["results"][number];
    source: TrainingSourceRef;
  }) => void | Promise<void>;
}) {
  assertCrossSystemWorldSpecs(input.worldSpecs);
  const worlds = input.worldSpecs.map(generateCrossSystemWorld);
  const tasks = worlds.flatMap(generateCrossSystemTasks);
  const rawSources: TrainingSourceRef[] = [];
  const baseline = await runFrontierCrossSystemBaseline({
    worlds,
    tasks,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    stream: input.stream,
    signal: input.signal,
    onTaskStarted: input.onTaskStarted,
    onTaskCompleted: async ({ index, total, task, trajectory, result }) => {
      const source = await input.createEvidenceSource({ profileId: input.profileId, task, trajectory });
      rawSources.push(source);
      await input.onTaskRecorded?.({ index, total, task, trajectory, result, source });
    },
  });
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
