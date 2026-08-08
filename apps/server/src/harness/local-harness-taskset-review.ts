import path from "node:path";

import { loadOpenPondProfileState } from "@openpond/cloud";
import { contentHash } from "@openpond/taskset-sdk";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { startHarnessReviewTasksetAuthoring } from "../training/harness-review-taskset.js";
import { loadTasksetAuthoringSkillArtifact } from "../training/task-authoring-skill.js";
import { createTaskCreatorService } from "../training/task-creator.js";

export async function createLocalHarnessTasksetReviewControl(input: {
  store: SqliteStore;
  storeDir: string;
}) {
  const tasksetAuthoringSkill = await loadTasksetAuthoringSkillArtifact();
  const taskCreator = createTaskCreatorService({
    store: input.store,
    tasksetRootDir: path.join(input.storeDir, "training", "tasksets"),
    authoringSkillHash: contentHash(tasksetAuthoringSkill.bundle),
    loadProfileState: loadOpenPondProfileState,
  });
  await taskCreator.reconcileInterruptedCreations();

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
  };
}
