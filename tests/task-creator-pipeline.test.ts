import { describe, expect, test } from "bun:test";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { contentHash } from "../packages/taskset-sdk/src";
import { seedConversation, withTrainingStore } from "./helpers/training-fixtures";

describe("Task Creator pipeline", () => {
  test("estimates and imports Codex history chats that are not in the OpenPond session store", async () => withTrainingStore(async ({ store }) => {
    const sessionId = "codex_history_thread_fixture";
    const session = {
      id: sessionId,
      provider: "codex" as const,
      title: "Codex chat",
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
    const service = createTaskCreatorService({
      store,
      authoringSkillHash: contentHash("skill"),
      loadCodexHistoryThread: async () => ({ session, events }),
    });

    const [estimate] = await service.estimateSessionSources([sessionId]);
    expect(estimate).toMatchObject({ sessionId, messageCount: 2 });
    expect(estimate!.estimatedTokens).toBeGreaterThan(0);

    const source = await service.addSessionSource({ profileId: "default", sessionId });
    expect(source.turnIds).toEqual(["history_turn"]);
    expect(source.metadata).toMatchObject({ messageCount: 2, estimatedTokens: estimate!.estimatedTokens });
    expect(source.metadata.workflowSignature).not.toBe("general_workflow");
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
});
