import { randomUUID } from "node:crypto";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemWorldSpec,
  type TrainingSourceRef,
} from "@openpond/contracts";
import type { SqliteStore } from "../../store/store.js";
import { buildCrossSystemBootstrapDataset } from "./bootstrap-dataset.js";
import { crossSystemTrainingSourceAttemptMetadata } from "./baseline.js";
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
  const sources: TrainingSourceRef[] = [];
  const baselineId = `cso_frontier_baseline_${randomUUID()}`;
  const approvedAt = new Date().toISOString();
  const approvedBy = input.approvedBy ?? "local_user_frontier_baseline";
  const baseline = await runFrontierCrossSystemBaseline({
    worlds,
    tasks,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    stream: input.stream,
    reportId: baselineId,
    signal: input.signal,
    onTaskStarted: input.onTaskStarted,
    onTaskCompleted: async ({ index, total, task, trajectory, result }) => {
      const rawSource = await input.createEvidenceSource({ profileId: input.profileId, task, trajectory });
      const approved = result.outcome === "correct" && result.rewardEligible;
      const [bootstrapRecord] = approved
        ? buildCrossSystemBootstrapDataset({
          tasks: [task],
          trajectories: [trajectory],
          results: [result],
          approvedTrajectoryIds: [trajectory.id],
          approvedBy,
          approvedAt,
        })
        : [];
      const generatedMetadata = crossSystemTrainingSourceAttemptMetadata({
        trajectory,
        result,
        baselineId,
        approved,
      });
      const source = await input.store.upsertTrainingSource({
        ...rawSource,
        clusterKey: trajectory.worldId,
        metadata: {
          ...rawSource.metadata,
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
      });
      sources.push(source);
      await input.onTaskRecorded?.({ index, total, task, trajectory, result, source });
    },
  });
  const approvedTrajectoryIds = baseline.results.flatMap((result) =>
    result.outcome === "correct" && result.rewardEligible ? [result.trajectoryId] : [],
  );
  const bootstrap = buildCrossSystemBootstrapDataset({
    tasks,
    trajectories: baseline.trajectories,
    results: baseline.results,
    approvedTrajectoryIds,
    approvedBy,
    approvedAt,
  });
  return {
    schemaVersion: "openpond.crossSystemFrontierBaseline.v1" as const,
    report: baseline.report,
    trajectories: baseline.trajectories,
    results: baseline.results,
    sources,
    bootstrap,
  };
}
