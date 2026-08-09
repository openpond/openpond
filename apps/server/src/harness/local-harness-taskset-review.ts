import path from "node:path";

import { loadOpenPondProfileState } from "@openpond/cloud";
import { contentHash } from "@openpond/taskset-sdk";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { startHarnessReviewTasksetAuthoring } from "../training/harness-review-taskset.js";
import { loadTasksetAuthoringSkillArtifact } from "../training/task-authoring-skill.js";
import { createTaskCreatorService } from "../training/task-creator.js";
import { createTaskEvaluationService } from "../training/evaluation-service.js";
import {
  HarnessReviewBaselineRequestSchema,
  runHarnessReviewBaselineAndQualification,
} from "../training/harness-model-improvement.js";
import { createTrainingModelRuntime } from "../training/training-model-runtime.js";
import type { TasksetWorkAttemptRuntime } from "../training/taskset-work-attempt-runner.js";

export async function createLocalHarnessTasksetReviewControl(input: {
  store: SqliteStore;
  storeDir: string;
  evaluationRuntime?: {
    streamOpenPondHostedChatTurn: typeof streamOpenPondHostedChatTurn;
    workRuntime: TasksetWorkAttemptRuntime;
    resolveReleasedHarness: NonNullable<
      Parameters<typeof createTaskEvaluationService>[0]["resolveReleasedHarness"]
    >;
  };
}) {
  const tasksetAuthoringSkill = await loadTasksetAuthoringSkillArtifact();
  const taskCreator = createTaskCreatorService({
    store: input.store,
    tasksetRootDir: path.join(input.storeDir, "training", "tasksets"),
    authoringSkillHash: contentHash(tasksetAuthoringSkill.bundle),
    loadProfileState: loadOpenPondProfileState,
  });
  await taskCreator.reconcileInterruptedCreations();
  const evaluation = input.evaluationRuntime
    ? createHarnessEvaluationService({
        store: input.store,
        storeDir: input.storeDir,
        ...input.evaluationRuntime,
      })
    : null;

  return {
    acceptEvaluationReview: async (request: unknown) => {
      const parsed = z.object({
        workspaceId: z.string().trim().min(1),
        reviewRef: z.object({
          id: z.string().trim().min(1),
          contentHash: z.string().trim().min(1),
        }).strict(),
      }).strict().parse(request);
      const profile = await loadOpenPondProfileState();
      return startHarnessReviewTasksetAuthoring({
        store: input.store,
        taskCreator,
        startCreation: taskCreator.start,
        profileId: profile.activeProfile ?? "default",
        workspaceId: parsed.workspaceId,
        reviewRef: parsed.reviewRef,
      });
    },
    materializeEvaluationTaskset: async (request: unknown) => {
      const parsed = z.object({
        creationId: z.string().trim().min(1),
      }).strict().parse(request);
      return taskCreator.approveMaterialization(parsed.creationId, true);
    },
    runEvaluationBaseline: async (request: unknown) => {
      if (!evaluation) {
        throw new Error("Harness baseline Evaluation is not configured.");
      }
      return runLocalHarnessEvaluationBaseline({
        store: input.store,
        evaluation,
        request,
        requireOpenPondProvider: true,
      });
    },
  };
}

export async function runLocalHarnessEvaluationBaseline(input: {
  store: SqliteStore;
  evaluation: Pick<ReturnType<typeof createTaskEvaluationService>, "executeBaseline">;
  request: unknown;
  requireOpenPondProvider?: boolean;
}) {
  const parsed = HarnessReviewBaselineRequestSchema.parse(input.request);
  if (input.requireOpenPondProvider && parsed.model.providerId !== "openpond") {
    throw new Error("Hosted Harness baseline Evaluation requires the OpenPond provider.");
  }
  return runHarnessReviewBaselineAndQualification({
    store: input.store,
    evaluation: input.evaluation,
    ...parsed,
  });
}

function createHarnessEvaluationService(input: {
  store: SqliteStore;
  storeDir: string;
  streamOpenPondHostedChatTurn: typeof streamOpenPondHostedChatTurn;
  workRuntime: TasksetWorkAttemptRuntime;
  resolveReleasedHarness: NonNullable<
    Parameters<typeof createTaskEvaluationService>[0]["resolveReleasedHarness"]
  >;
}) {
  const modelRuntime = createTrainingModelRuntime({
    loadLocalByokRuntimeState: async () => {
      throw new Error("Hosted Harness baseline Evaluation does not load Local BYOK state.");
    },
    getTrainedAdapterChatRuntime: () => ({
      stream: async function* () {
        throw new Error("Hosted Harness baseline Evaluation does not use a trained Local adapter.");
      },
    }),
    streamOpenPondHostedChatTurn: input.streamOpenPondHostedChatTurn,
  });
  return createTaskEvaluationService({
    store: input.store,
    storeDir: input.storeDir,
    modelText: modelRuntime.trainingModelText,
    modelStream: modelRuntime.trainingModelStream,
    workRuntime: input.workRuntime,
    resolveReleasedHarness: input.resolveReleasedHarness,
  });
}
