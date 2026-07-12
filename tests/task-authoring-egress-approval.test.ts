import { describe, expect, test } from "bun:test";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { proposalFixture, seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("Task authoring disclosure approval", () => {
  test("does not send selected evidence to a hosted model before approval", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store);
    let authorCalls = 0;
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill"), authorProposal: async ({ evidence }) => { authorCalls += 1; expect(evidence[0]?.excerpts[0]?.text).toContain("Research this topic"); return proposalFixture(evidence.map((item) => item.source.id)); } });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "slash_train", mode: "defaults", objective: "Create a task.", analysisModel: { providerId: "openpond", modelId: "frontier" } });
    expect(creation.state).toBe("awaiting_disclosure_approval");
    expect(authorCalls).toBe(0);
    const approved = await service.approveDisclosure(creation.id, true);
    expect(approved.state).toBe("awaiting_materialization_approval");
    expect(authorCalls).toBe(1);
  }));

  test("persists planning before authoring and records provider failures", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store);
    let observedState: string | null = null;
    let creationId = "";
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      authorProposal: async () => {
        observedState = (await store.getTaskCreationSnapshot(creationId))?.state ?? null;
        throw new Error("Synthetic authoring failure.");
      },
    });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "slash_train", mode: "defaults", objective: "Create a task.", analysisModel: { providerId: "openpond", modelId: "frontier" } });
    creationId = creation.id;
    const failed = await service.approveDisclosure(creation.id, true);
    expect(failed.state).toBe("failed");
    expect(failed.blockedReason).toBe("Synthetic authoring failure.");
    expect((await store.getTaskCreationSnapshot(creation.id))?.state).toBe("failed");
    expect(observedState).toBe("planning");
  }));
});
