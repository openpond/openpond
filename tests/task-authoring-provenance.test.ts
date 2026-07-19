import { describe, expect, test } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("Task authoring provenance", () => {
  test("records the real skill hash, evidence hashes, template, SDK, and source commit", async () => withTrainingStore(async ({ store, directory }) => {
    const profileSource = path.join(directory, "profile");
    await mkdir(profileSource, { recursive: true });
    await seedConversation(store, { sessionId: "session_training", turnId: "turn_training", title: "Approved training behavior" });
    await seedConversation(store, { sessionId: "session_evaluation", turnId: "turn_evaluation", title: "Independent evaluation behavior" });
    const skill = "# versioned authoring skill";
    const service = createTaskCreatorService({ store, tasksetRootDir: path.join(directory, "training", "tasksets"), authoringSkillHash: contentHash(skill), loadProfileState: async () => ({ mode: "local", activeProfile: "default", sourcePath: profileSource, git: { head: "abc123" } } as any) });
    const train = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const evaluation = await service.addSessionSource({ profileId: "default", sessionId: "session_evaluation" });
    const creation = await service.start({ profileId: "default", sourceIds: [train.id, evaluation.id], surface: "session_menu", mode: "defaults", objective: "Create task." });
    const ready = await service.approveMaterialization(creation.id, true);
    const taskset = await store.getTaskset(ready.materializedTasksetId!);
    expect(taskset?.authoringProvenance).toMatchObject({ skillHash: contentHash(skill), promptTemplateVersion: "task-authoring.v2", tasksetSdkVersion: "0.0.1", sourceCommit: "abc123", evidenceHashes: [train.sourceHash, evaluation.sourceHash] });
  }));
});
