import { describe, expect, test } from "vitest";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("Task Creator pipeline", () => {
  test("reconciles an interrupted authoring snapshot after restart without losing reviewed evidence", async () => withTrainingStore(async ({ store, directory }) => {
    await seedConversation(store, { sessionId: "session_interrupted_authoring", turnId: "turn_interrupted_authoring", title: "Interrupted authoring evidence" });
    const initial = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill") });
    const source = await initial.addSessionSource({ profileId: "default", sessionId: "session_interrupted_authoring" });
    const creation = await initial.start({
      profileId: "default",
      sourceIds: [source.id],
      surface: "training_page",
      mode: "customize",
      objective: "Preserve this reviewed workflow.",
      analysisModel: { providerId: "openai", modelId: "gpt-5.6-sol" },
    });
    expect(creation.state).toBe("awaiting_disclosure_approval");
    await store.upsertTaskCreationSnapshot({ ...creation, state: "planning", updatedAt: "2026-07-15T00:00:00.000Z" });

    const restarted = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      loadProfileState: async () => ({ mode: "local", activeProfile: "default", sourcePath: directory } as any),
    });
    await restarted.reconcileInterruptedCreations();
    const reconciled = await store.getTaskCreationSnapshot(creation.id);
    expect(reconciled).toMatchObject({
      state: "failed",
      request: { sourceIds: [source.id] },
      blockedReason: expect.stringContaining("OpenPond restarted during Taskset authoring"),
    });
    expect(reconciled?.transcript.at(-1)?.text).toContain("reviewed evidence");
  }));

  test("estimates and imports Codex history chats that are not in the OpenPond session store", async () => withTrainingStore(async ({ store }) => {
    const sessionId = "codex_history_thread_fixture";
    const session = {
      id: sessionId,
      provider: "codex" as const,
      title: "Codex chat ",
      appId: null,
      appName: null,
      cwd: "/tmp/openpond",
      codexThreadId: "thread_fixture",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:01:00.000Z",
      status: "idle" as const,
      pinned: false,
      archived: false,
      order: 0,
    };
    const events = [
      { id: "history_started", sessionId, turnId: "history_turn", name: "turn.started" as const, timestamp: session.createdAt, args: { prompt: "Review customer requests and prepare a launch brief." } },
      { id: "history_answer", sessionId, turnId: "history_turn", name: "assistant.delta" as const, timestamp: session.updatedAt, output: "Prepared the launch brief from the approved requests." },
      { id: "history_completed", sessionId, turnId: "history_turn", name: "turn.completed" as const, timestamp: session.updatedAt },
    ];
    let historyReads = 0;
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      loadCodexHistoryThread: async () => ({ session: { ...session, updatedAt: new Date(Date.parse(session.updatedAt) + historyReads++ * 1_000).toISOString() }, events }),
    });

    const [estimate] = await service.estimateSessionSources([sessionId]);
    expect(estimate).toMatchObject({ sessionId, messageCount: 2 });
    expect(estimate!.estimatedTokens).toBeGreaterThan(0);

    const source = await service.addSessionSource({ profileId: "default", sessionId });
    expect(source.turnIds).toEqual(["history_turn"]);
    expect(source.metadata).toMatchObject({ messageCount: 2, estimatedTokens: estimate!.estimatedTokens });
    expect(source.licensingStatus).toBe("approved");
    expect(source.metadata.licensingBasis).toBe("local_user_selected_chat");
    expect(source.metadata.workflowSignature).not.toBe("general_workflow");
    await store.upsertTrainingSource({ ...source, licensingStatus: "review", metadata: { ...source.metadata, licensingBasis: "legacy_review" } });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "training_page", mode: "defaults", objective: "Create a stable task draft." });
    expect((await store.getTrainingSource(source.id))?.licensingStatus).toBe("approved");
    expect(creation.state).toBe("recommendation_ready");
    expect(creation.materializedTasksetId).toBeNull();
    expect(creation.proposal?.warnings).toContain("No independent evaluation example was proposed.");
  }));

  test("keeps connected-app chat licensing under review", async () => withTrainingStore(async ({ store }) => {
    const { session } = await seedConversation(store, { sessionId: "session_connected", turnId: "turn_connected", title: "Connected support chat" });
    await store.mutate((data) => {
      const index = data.sessions.findIndex((item) => item.id === session.id);
      data.sessions[index] = { ...data.sessions[index]!, appId: "slack", appName: "Slack" };
    });
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill") });
    const source = await service.addSessionSource({ profileId: "default", sessionId: session.id });
    expect(source.connectedAppIds).toEqual(["slack"]);
    expect(source.licensingStatus).toBe("review");
    await service.start({ profileId: "default", sourceIds: [source.id], surface: "training_page", mode: "defaults", objective: "Review this workflow." });
    expect((await store.getTrainingSource(source.id))?.licensingStatus).toBe("review");
  }));

  test("reuses matching specialized evidence without expanding its consent scope", async () => withTrainingStore(async ({ store }) => {
    const { session, turn } = await seedConversation(store, {
      sessionId: "session_specialized",
      turnId: "turn_specialized",
      title: "Cross-System baseline evidence",
      assistant: "ANSWER: {\"invoice_ids\":[\"inv_1\"]}",
    });
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill") });
    const selected = await service.addSessionSource({
      profileId: "default",
      sessionId: session.id,
      turnIds: [turn.id],
      consentScope: "selected_turns",
    });
    const specialized = await store.upsertTrainingSource({
      ...selected,
      metadata: {
        ...selected.metadata,
        workflowSignature: "cross-system-operations",
        crossSystemOperations: { trajectoryId: "trajectory_specialized", approved: true },
      },
    });
    const reused = await service.addSessionSource({
      profileId: "default",
      sessionId: session.id,
      consentScope: "full_session",
    });
    expect(reused.id).toBe(specialized.id);
    expect(reused.consent.scope).toBe("selected_turns");
    expect(reused.metadata).toMatchObject({
      workflowSignature: "cross-system-operations",
      crossSystemOperations: { trajectoryId: "trajectory_specialized", approved: true },
    });
    expect(await store.listTrainingSources("default")).toHaveLength(1);
  }));

  test("turns selected chats into an approved source-owned Taskset", async () => withTrainingStore(async ({ store, directory }) => {
    const profileSource = path.join(directory, "profile");
    await mkdir(profileSource, { recursive: true });
    await seedConversation(store, { sessionId: "session_train", turnId: "turn_train", title: "Research workflow one", assistant: "Approved training response." });
    await seedConversation(store, { sessionId: "session_eval", turnId: "turn_eval", title: "Research workflow two", assistant: "Approved frozen response." });
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill"), loadProfileState: async () => ({ mode: "local", activeProfile: "default", sourcePath: profileSource, git: { head: "commit123" } } as any) });
    const first = await service.addSessionSource({ profileId: "default", sessionId: "session_train" });
    const second = await service.addSessionSource({ profileId: "default", sessionId: "session_eval" });
    const creation = await service.start({ profileId: "default", sourceIds: [first.id, second.id], surface: "bulk_selection", mode: "defaults", objective: "Reproduce approved research updates." });
    expect(creation.state).toBe("awaiting_materialization_approval");
    expect(await store.getTaskCreationTranscript(creation.id)).toMatchObject({ creationId: creation.id, messages: expect.any(Array) });
    expect(await store.getTaskDesignProposal(creation.id)).toMatchObject({ id: creation.proposal?.id, objective: creation.proposal?.objective });
    const ready = await service.approveMaterialization(creation.id, true);
    expect(ready.state).toBe("ready");
    const taskset = await store.getTaskset(ready.materializedTasksetId!);
    expect(taskset?.tasks.map((task) => task.split)).toEqual(["train", "frozen_eval"]);
    expect(new Set(taskset?.tasks.map((task) => task.clusterKey)).size).toBe(2);
    expect(taskset?.graderFixtures).toHaveLength(6);
    const root = path.join(profileSource, "tasksets", taskset!.id);
    await access(path.join(root, "taskset.json"));
    await access(path.join(root, "environment", "taskset.ts"));
    expect(await readFile(path.join(root, "fixtures", "grader-fixtures.json"), "utf8")).toContain("prompt_injection");
  }));

  test("does not materialize a trainable Taskset without an independent test chat", async () => withTrainingStore(async ({ store, directory }) => {
    const profileSource = path.join(directory, "profile");
    await mkdir(profileSource, { recursive: true });
    await seedConversation(store, { sessionId: "session_only", turnId: "turn_only", title: "Approved workflow", assistant: "Approved training response." });
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill"), loadProfileState: async () => ({ mode: "local", activeProfile: "default", sourcePath: profileSource, git: { head: "commit123" } } as any) });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_only" });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "slash_train", mode: "defaults", objective: "Reproduce the approved workflow.", methodHint: "grpo" });
    expect(creation.proposal?.proposedMethod).toBe("grpo");
    expect(creation.state).toBe("recommendation_ready");
    expect(creation.materializedTasksetId).toBeNull();
    expect(creation.proposal?.warnings).toContain("No independent evaluation example was proposed.");
    expect(await store.listTasksets("default")).toHaveLength(0);
    await expect(service.approveMaterialization(creation.id, true)).rejects.toThrow("Task creation is not ready for materialization approval.");
  }));

  test("carries preference tuning as a typed authoring preference", async () => withTrainingStore(async ({ store }) => {
    await seedConversation(store, { sessionId: "session_preference", turnId: "turn_preference", title: "Reviewed response correction", assistant: "Approved corrected response." });
    const service = createTaskCreatorService({ store, authoringSkillHash: contentHash("skill") });
    const source = await service.addSessionSource({ profileId: "default", sessionId: "session_preference" });
    const creation = await service.start({ profileId: "default", sourceIds: [source.id], surface: "training_page", mode: "defaults", objective: "Learn from reviewed response corrections.", methodHint: "dpo" });
    expect(creation.request.methodHint).toBe("dpo");
    expect(creation.proposal?.proposedMethod).toBe("dpo");
    expect(creation.proposal?.diagnosis.intervention).toBe("preference");
    expect(creation.state).toBe("recommendation_ready");
  }));
});
