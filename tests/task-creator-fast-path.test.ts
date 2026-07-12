import { describe, expect, test } from "bun:test";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("Task Creator fast path", () => {
  test("Create with defaults asks no preference questions when evidence is sufficient", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store);
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill") });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "training_page", mode: "defaults", objective: "Reproduce the selected approved behavior." });
    expect(creation.blockingQuestions).toEqual([]);
    expect(creation.state).toBe("awaiting_materialization_approval");
    expect(creation.proposal?.assumptions.length).toBeGreaterThan(0);
  }));
});
