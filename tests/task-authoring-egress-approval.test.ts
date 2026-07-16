import { describe, expect, test } from "vitest";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { proposalFixture, seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("Task authoring disclosure approval", () => {
  test("does not send selected evidence to a hosted model before approval", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store);
    let authorCalls = 0;
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill"), authorProposal: async ({ evidence, methodHint }) => { authorCalls += 1; expect(evidence[0]?.excerpts[0]?.text).toContain("Research this topic"); expect(methodHint).toBe("grpo"); return proposalFixture(evidence.map((item) => item.source.id)); } });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "slash_train", mode: "defaults", entryMode: "manual", objective: "Create a task.", methodHint: "grpo", analysisModel: { providerId: "openpond", modelId: "frontier" } });
    expect(creation.state).toBe("awaiting_disclosure_approval");
    expect(creation.request).toMatchObject({ entryMode: "manual", candidateId: null, disclosure: { status: "pending", content: "raw_excerpts", sourceIds: [source.id], providerModel: { providerId: "openpond", modelId: "frontier" } } });
    expect(authorCalls).toBe(0);
    const approved = await service.approveDisclosure(creation.id, true);
    expect(approved.state).toBe("recommendation_ready");
    expect(approved.request.disclosure.status).toBe("approved");
    expect(approved.request.disclosure.approvedAt).not.toBeNull();
    expect(authorCalls).toBe(1);
  }));

  test("keeps objective-only Manual authoring local and requests grounded evidence", async () => withTrainingStore(async ({ store }) => {
    let authorCalls = 0;
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill"), authorProposal: async () => { authorCalls += 1; return proposalFixture(); } });
    const creation = await service.start({ profileId: "default", sourceIds: [], surface: "training_page", mode: "defaults", entryMode: "manual", objective: "Reconcile billing and support risk.", analysisModel: { providerId: "openpond", modelId: "frontier" } });
    expect(creation.state).toBe("awaiting_questions");
    expect(creation.request.disclosure).toMatchObject({ status: "not_required", sourceIds: [] });
    expect(creation.blockingQuestions[0]).toMatchObject({ kind: "success_signal" });
    expect(creation.blockingQuestions[0]?.prompt).toContain("without fabricating demonstrations");
    expect(authorCalls).toBe(0);
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
