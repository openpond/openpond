import { describe, expect, test } from "bun:test";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { proposalFixture, seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("New model authoring boundary", () => {
  test("Automated candidates and Manual goals converge on the same approved request contract", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store);
    let authorCalls = 0;
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      authorProposal: async ({ evidence, id }) => {
        authorCalls += 1;
        return { ...proposalFixture(evidence.map((item) => item.source.id)), id };
      },
    });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const shared = {
      profileId: "default",
      sourceIds: [source.id],
      mode: "defaults" as const,
      objective: "Reconcile customer operations risk.",
      methodHint: null,
      analysisModel: { providerId: "openpond" as const, modelId: "frontier" },
      analysisReasoningEffort: "high" as const,
    };
    const manual = await service.start({ ...shared, surface: "training_page", entryMode: "manual" });
    const automated = await service.start({ ...shared, surface: "task_candidate", entryMode: "automated", candidateId: "candidate_cross_system" });

    expect(authorCalls).toBe(0);
    expect(manual.request).toMatchObject({ entryMode: "manual", surface: "training_page", candidateId: null });
    expect(automated.request).toMatchObject({ entryMode: "automated", surface: "task_candidate", candidateId: "candidate_cross_system" });
    expect(sharedRequestFields(manual.request)).toEqual(sharedRequestFields(automated.request));
    expect(manual.request.disclosure.status).toBe("pending");
    expect(automated.request.disclosure.status).toBe("pending");

    await service.approveDisclosure(manual.id, true);
    await service.approveDisclosure(automated.id, true);
    expect(authorCalls).toBe(2);
  }));
});

function sharedRequestFields(request: any) {
  return {
    schemaVersion: request.schemaVersion,
    profileId: request.profileId,
    mode: request.mode,
    objective: request.objective,
    methodHint: request.methodHint,
    sourceIds: request.sourceIds,
    analysisModel: request.analysisModel,
    analysisReasoningEffort: request.analysisReasoningEffort,
    disclosure: {
      content: request.disclosure.content,
      sourceIds: request.disclosure.sourceIds,
      providerModel: request.disclosure.providerModel,
      status: request.disclosure.status,
    },
  };
}
