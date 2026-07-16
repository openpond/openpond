import { describe, expect, test } from "vitest";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { authorTaskDesignWithModel } from "../apps/server/src/training/task-authoring-model";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { proposalFixture, seedConversation, sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("frontier-model Task Creator chat", () => {
  test("provides the bundled skill and repairs one invalid structured response", async () => {
    const calls: Array<Array<{ role: "system" | "user"; content: string }>> = [];
    let attempt = 0;
    const proposal = { ...proposalFixture(["source_train"]), proposedMethod: "grpo" as const };
    const result = await authorTaskDesignWithModel({ id: "proposal_fixture", model: { providerId: "openpond", modelId: "frontier" }, evidence: [{ source: sourceFixture(), excerpts: [{ role: "user", text: "Create the task", turnId: "turn" }] }], methodHint: "grpo", skillText: "# OpenPond Taskset Authoring\nPrefer deterministic graders.", stream: async function* (input) { calls.push(input.messages); attempt += 1; yield { text: attempt === 1 ? "not-json" : JSON.stringify({ schemaVersion: "openpond.taskAuthoringDecision.v1", proposal }) }; }, signal: new AbortController().signal });
    expect(result.proposal.id).toBe(proposal.id);
    expect(result.proposal.proposedMethod).toBe("grpo");
    expect(result.repairHistory).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]?.content).toContain("OpenPond Taskset Authoring");
    expect(calls[0]?.[0]?.content).toContain("TaskDesignProposal JSON schema");
    expect(calls[0]?.[0]?.content).toContain("final approval occurs when the user creates the Taskset");
    expect(calls[0]?.[1]?.content).toContain('"methodHint": "grpo"');
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

  test("enforces the policy-visible and privileged fields without a model repair round trip", async () => {
    const calls: Array<Array<{ role: "system" | "user"; content: string }>> = [];
    const proposal = {
      ...proposalFixture(["source_train"]),
      policy: { policyVisibleFields: [], privilegedFields: [], hiddenGraderRefs: [], connectedAppScopes: [] },
    };
    const result = await authorTaskDesignWithModel({
      id: "proposal_policy_boundary",
      model: { providerId: "openai", modelId: "frontier" },
      evidence: [{ source: sourceFixture(), excerpts: [{ role: "user", text: "Create the task", turnId: "turn" }] }],
      skillText: "# Skill",
      stream: async function* (input) {
        calls.push(input.messages);
        yield { text: JSON.stringify({ schemaVersion: "openpond.taskAuthoringDecision.v1", proposal }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toHaveLength(1);
    expect(result.repairHistory).toHaveLength(0);
    expect(result.proposal.policy.policyVisibleFields).toContain("input.prompt");
    expect(result.proposal.policy.privilegedFields).toContain("expectedOutput.text");
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

  test("authors a stable behavior with independent evaluation and materializes its executable files", async () => withTrainingStore(async ({ store, directory }) => {
    const profileSource = path.join(directory, "profile");
    await mkdir(profileSource, { recursive: true });
    await seedConversation(store, { sessionId: "session_brief_train", turnId: "turn_brief_train", title: "Weekly launch brief", prompt: "Turn these approved notes into our weekly launch brief.", assistant: "Launch brief with the approved structure." });
    await seedConversation(store, { sessionId: "session_brief_eval", turnId: "turn_brief_eval", title: "Monthly launch brief", prompt: "Turn these approved notes into our monthly launch brief.", assistant: "Independent launch brief with the approved structure." });
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      loadProfileState: async () => ({ mode: "local", activeProfile: "default", sourcePath: profileSource, git: { head: "commit123" } } as any),
      authorProposal: async ({ evidence }) => {
        const [train, evaluation] = evidence.map((item) => item.source);
        const fixture = proposalFixture();
        return {
          ...fixture,
          id: "proposal_launch_brief",
          name: "Approved launch brief style",
          objective: "Reproduce the stable structure and judgment used in approved launch briefs.",
          sourceIds: [train!.id, evaluation!.id],
          diagnosis: {
            ...fixture.diagnosis,
            summary: "The chats repeat a stable editorial structure over changing launch facts.",
            stableBehavior: ["Apply the approved launch-brief structure and concise editorial style."],
            changingKnowledge: ["Current launch facts and dates must stay in the prompt or retrieval context."],
            requiredContext: ["The approved notes for the current launch."],
            rationale: ["Two independent conversations demonstrate the same stable transformation over different source facts."],
          },
          proposedExamples: [
            { id: "example_launch_train", sourceId: train!.id, sourceTurnId: null, split: "train" as const, origin: "corrected" as const, inputPrompt: "Turn these approved notes into our weekly launch brief.", expectedOutputText: "Launch brief with the approved structure.", rationale: "Approved training example from the first conversation." },
            { id: "example_launch_eval", sourceId: evaluation!.id, sourceTurnId: null, split: "frozen_eval" as const, origin: "corrected" as const, inputPrompt: "Turn these approved notes into our monthly launch brief.", expectedOutputText: "Independent launch brief with the approved structure.", rationale: "Independent evaluation example from a separate conversation." },
          ],
        };
      },
    });
    const trainSource = await service.addSessionSource({ profileId: "default", sessionId: "session_brief_train" });
    const evaluationSource = await service.addSessionSource({ profileId: "default", sessionId: "session_brief_eval" });
    const pending = await service.start({ profileId: "default", sourceIds: [trainSource.id, evaluationSource.id], surface: "training_page", mode: "defaults", analysisModel: { providerId: "openai", modelId: "gpt-5.4" }, analysisReasoningEffort: "high" });
    const reviewed = await service.approveDisclosure(pending.id, true);
    expect(reviewed.state).toBe("awaiting_materialization_approval");
    expect(reviewed.request.analysisModel).toEqual({ providerId: "openai", modelId: "gpt-5.4" });
    expect(reviewed.proposal?.diagnosis.stableBehavior).toHaveLength(1);
    expect(reviewed.proposal?.diagnosis.changingKnowledge).toHaveLength(1);
    expect(reviewed.proposal?.diagnosis.requiredContext).toHaveLength(1);
    expect(reviewed.proposal?.proposedExamples.map((example) => example.split)).toEqual(["train", "frozen_eval"]);
    expect(reviewed.proposal?.proposedGraders.length).toBeGreaterThan(0);
    expect(reviewed.proposal?.trainingPath).toEqual({ primaryMethod: "sft", bootstrap: null });

    const renamed = await service.rename(reviewed.id, "Launch brief specialist");
    expect(renamed.proposal?.name).toBe("Launch brief specialist");
    const ready = await service.approveMaterialization(renamed.id, true);
    expect(ready.state).toBe("ready");
    const taskset = await store.getTaskset(ready.materializedTasksetId!);
    expect(taskset?.name).toBe("Launch brief specialist");
    expect(taskset?.tasks.map((task) => task.split)).toEqual(["train", "frozen_eval"]);
    const tasksetRoot = path.join(profileSource, "tasksets", taskset!.id);
    await access(path.join(tasksetRoot, "taskset.json"));
    await access(path.join(tasksetRoot, "environment", "taskset.ts"));
    await access(path.join(tasksetRoot, "fixtures", "grader-fixtures.json"));
  }));

  test("materializes a provider-neutral GRPO Taskset without relabeling its SFT bootstrap", async () => withTrainingStore(async ({ store, directory }) => {
    const profileSource = path.join(directory, "profile-grpo");
    await mkdir(profileSource, { recursive: true });
    await seedConversation(store, { sessionId: "session_ops_train", turnId: "turn_ops_train", title: "Cross-system renewal risk", prompt: "Find renewal risk.", assistant: "ANSWER: {\"accounts\":[\"acct_1\"]}" });
    await seedConversation(store, { sessionId: "session_ops_eval", turnId: "turn_ops_eval", title: "Cross-system collection risk", prompt: "Find collection risk.", assistant: "ANSWER: {\"accounts\":[\"acct_2\"]}" });
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      loadProfileState: async () => ({ mode: "local", activeProfile: "default", sourcePath: profileSource } as any),
      authorProposal: async ({ evidence }) => {
        const fixture = proposalFixture();
        const [train, evaluation] = evidence.map((item) => item.source);
        return {
          ...fixture,
          id: "proposal_cross_system_grpo",
          name: "Cross-system operations specialist",
          taskKind: "single_agent" as const,
          sourceIds: [train!.id, evaluation!.id],
          diagnosis: { ...fixture.diagnosis, intervention: "grpo_rft" as const, requiredTools: ["search_crm", "query_billing", "search_support", "run_python"], rationale: ["Deterministic tool outcomes provide a reward while successful frontier trajectories provide a bootstrap." ] },
          proposedMethod: "grpo" as const,
          proposedExamples: [
            { id: "trajectory_train", sourceId: train!.id, sourceTurnId: null, split: "train" as const, origin: "corrected" as const, inputPrompt: "Find renewal risk.", expectedOutputText: "ANSWER: {\"accounts\":[\"acct_1\"]}", rationale: "Approved successful trajectory." },
            { id: "trajectory_eval", sourceId: evaluation!.id, sourceTurnId: null, split: "frozen_eval" as const, origin: "corrected" as const, inputPrompt: "Find collection risk.", expectedOutputText: "ANSWER: {\"accounts\":[\"acct_2\"]}", rationale: "Independent frozen trajectory." },
          ],
        };
      },
    });
    const train = await service.addSessionSource({ profileId: "default", sessionId: "session_ops_train" });
    const evaluation = await service.addSessionSource({ profileId: "default", sessionId: "session_ops_eval" });
    const pending = await service.start({ profileId: "default", sourceIds: [train.id, evaluation.id], surface: "task_candidate", mode: "defaults", entryMode: "automated", candidateId: "candidate_ops", analysisModel: { providerId: "openpond", modelId: "frontier" } });
    const reviewed = await service.approveDisclosure(pending.id, true);
    expect(reviewed.state).toBe("awaiting_materialization_approval");
    expect(reviewed.proposal?.trainingPath).toMatchObject({ primaryMethod: "grpo", bootstrap: { method: "sft", purpose: "trajectory_bootstrap", demonstrationRefs: ["trajectory_train"] } });

    const ready = await service.approveMaterialization(reviewed.id, true);
    const taskset = await store.getTaskset(ready.materializedTasksetId!);
    expect(taskset?.metadata).toMatchObject({ trainingMethod: "grpo", trainingPath: { primaryMethod: "grpo", bootstrap: { method: "sft" } } });
    expect(taskset?.capabilities.compatibleMethods).toEqual(["grpo", "sft"]);
    expect(taskset?.environment.toolNames).toEqual(["search_crm", "query_billing", "search_support", "run_python"]);
  }));

  test("recommends retrieval for changing facts without creating a Taskset or model row", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store, { sessionId: "session_policy_one", turnId: "turn_policy_one", title: "Current policy lookup", prompt: "What is the current refund policy?", assistant: "The current policy is in the handbook." });
    await seedConversation(store, { sessionId: "session_policy_two", turnId: "turn_policy_two", title: "Updated policy lookup", prompt: "What changed in the refund policy?", assistant: "Use the latest handbook revision." });
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      authorProposal: async ({ evidence }) => {
        const fixture = proposalFixture();
        return {
          ...fixture,
          id: "proposal_policy_retrieval",
          name: "Current policy answers",
          objective: "Answer questions from the latest company policy.",
          sourceIds: evidence.map((item) => item.source.id),
          diagnosis: {
            ...fixture.diagnosis,
            summary: "The useful signal is changing policy knowledge, not a stable behavior to place in weights.",
            stableBehavior: [],
            changingKnowledge: ["Refund policy text changes over time."],
            requiredContext: ["The latest approved employee handbook revision."],
            intervention: "retrieval" as const,
            trainingEligible: false,
            rationale: ["Both conversations depend on whichever policy revision is current at runtime."],
            confidence: 0.98,
          },
          proposedExamples: [],
          proposedGraders: [],
          graderFixtures: [],
          generatedFiles: [],
          proposedMethod: "retrieval" as const,
        };
      },
    });
    const first = await service.addSessionSource({ profileId: "default", sessionId: "session_policy_one" });
    const second = await service.addSessionSource({ profileId: "default", sessionId: "session_policy_two" });
    const pending = await service.start({ profileId: "default", sourceIds: [first.id, second.id], surface: "training_page", mode: "defaults", analysisModel: { providerId: "openai", modelId: "gpt-5.4" } });
    const recommendation = await service.approveDisclosure(pending.id, true);
    expect(recommendation.state).toBe("recommendation_ready");
    expect(recommendation.proposal?.diagnosis).toMatchObject({ intervention: "retrieval", trainingEligible: false });
    expect(recommendation.proposal?.proposedExamples).toHaveLength(0);
    expect(await store.listTasksets("default")).toHaveLength(0);
  }));

  test("keeps a conceptual training discussion as a no-training recommendation", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store, {
      sessionId: "session_training_concept",
      turnId: "turn_training_concept",
      title: "When should we fine-tune?",
      prompt: "Can you explain when fine-tuning is appropriate?",
      assistant: "Fine-tuning is appropriate when repeated examples demonstrate stable behavior.",
    });
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      authorProposal: async ({ evidence }) => {
        const fixture = proposalFixture();
        return {
          ...fixture,
          id: "proposal_training_concept",
          name: "Training concept discussion",
          objective: "Explain when fine-tuning is appropriate.",
          sourceIds: evidence.map((item) => item.source.id),
          diagnosis: {
            ...fixture.diagnosis,
            summary: "The selected chat discusses training but does not demonstrate a repeated operational capability.",
            stableBehavior: [],
            changingKnowledge: [],
            requiredContext: [],
            requiredTools: [],
            intervention: "no_training" as const,
            trainingEligible: false,
            rationale: ["A conceptual explanation is not outcome-bearing training evidence."],
            confidence: 0.99,
          },
          proposedExamples: [],
          proposedGraders: [],
          graderFixtures: [],
          generatedFiles: [],
          proposedMethod: "none" as const,
        };
      },
    });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_training_concept" });
    const pending = await service.start({
      profileId: "default",
      sourceIds: [source.id],
      surface: "training_page",
      mode: "defaults",
      objective: "Teach the model when fine-tuning is appropriate.",
      analysisModel: { providerId: "openai", modelId: "gpt-5.4" },
    });
    const recommendation = await service.approveDisclosure(pending.id, true);
    expect(recommendation).toMatchObject({ state: "recommendation_ready", proposal: { proposedMethod: "none", diagnosis: { intervention: "no_training", trainingEligible: false } } });
    expect(recommendation.materializedTasksetId).toBeNull();
    expect(await store.listTasksets("default")).toHaveLength(0);
    await expect(service.approveMaterialization(recommendation.id, true)).rejects.toThrow("not ready for materialization approval");
  }));
});
