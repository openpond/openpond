import { describe, expect, test } from "bun:test";
import { authorTaskDesignWithModel } from "../apps/server/src/training/task-authoring-model";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { proposalFixture, seedConversation, sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("frontier-model Task Creator chat", () => {
  test("provides the bundled skill and repairs one invalid structured response", async () => {
    const calls: Array<Array<{ role: "system" | "user"; content: string }>> = [];
    let attempt = 0;
    const proposal = proposalFixture(["source_train"]);
    const result = await authorTaskDesignWithModel({ id: "proposal_fixture", model: { providerId: "openpond", modelId: "frontier" }, evidence: [{ source: sourceFixture(), excerpts: [{ role: "user", text: "Create the task", turnId: "turn" }] }], skillText: "# OpenPond Taskset Authoring\nPrefer deterministic graders.", stream: async function* (input) { calls.push(input.messages); attempt += 1; yield { text: attempt === 1 ? "not-json" : JSON.stringify({ schemaVersion: "openpond.taskAuthoringDecision.v1", proposal }) }; }, signal: new AbortController().signal });
    expect(result.proposal.id).toBe(proposal.id);
    expect(result.repairHistory).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]?.content).toContain("OpenPond Taskset Authoring");
    expect(calls[0]?.[0]?.content).toContain("TaskDesignProposal JSON schema");
    expect(calls[1]?.at(-1)?.content).toContain("prior response was invalid");
  });

  test("bounds a stalled authoring provider", async () => {
    await expect(authorTaskDesignWithModel({
      id: "proposal_timeout",
      model: { providerId: "openpond", modelId: "frontier" },
      evidence: [],
      skillText: "# Skill",
      stream: async function* ({ signal }) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      signal: new AbortController().signal,
      timeoutMs: 10,
    })).rejects.toThrow("Task authoring timed out after 10ms");
  });

  test("Customize revises the typed proposal through the persisted authoring chat", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store);
    let calls = 0;
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill"), authorProposal: async ({ evidence, instruction, currentProposal }) => { calls += 1; const proposal = proposalFixture(evidence.map((item) => item.source.id)); return { ...proposal, id: `proposal_${calls}`, name: instruction ? "Revised task design" : proposal.name, assumptions: currentProposal ? [...currentProposal.assumptions, "Revised in chat."] : proposal.assumptions }; } });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training" });
    const pending = await service.start({ profileId: "default", sourceIds: [source.id], surface: "training_page", mode: "customize", objective: "Create a task.", analysisModel: { providerId: "openpond", modelId: "frontier" } });
    const planned = await service.approveDisclosure(pending.id, true);
    const revised = await service.chat(planned.id, "Make the grader stricter.");
    expect(revised.proposal?.name).toBe("Revised task design");
    expect(revised.transcript.at(-2)).toMatchObject({ role: "user", text: "Make the grader stricter." });
    expect(revised.transcript.at(-1)).toMatchObject({ role: "assistant" });
    expect(await store.getTaskDesignProposal(revised.id)).toMatchObject({ id: "proposal_2" });
  }));
});
