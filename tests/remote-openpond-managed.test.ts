import { expect, test } from "vitest";
import { ProviderConfigSchema } from "@openpond/contracts";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";
import { createLocalManagedMessaging } from "../apps/server/src/runtime/task-inbox/local-managed-messaging";
import { createLocalManagedReadiness } from "../apps/server/src/runtime/task-inbox/local-managed-readiness";
import { event } from "../apps/server/src/utils";
import { decisionScoreFixture } from "./helpers/decision-score-fixture";

// Failure story: the relay treats an owned OpenPond tool-loop task as imported
// history, starts another conversation, or executes a retry as another turn.
test("managed OpenPond follow-up retains canonical history and retry identity", async () => {
  const requests: string[] = [];
  let accountAvailable = true;
  const harness = createTurnRunnerTestHarness({
    sessions: [turnRunnerTestSession({ provider: "openpond", modelRef: { providerId: "openpond", modelId: "managed-qa" },
      experience: "work", localProjectId: "private-qa", workspaceKind: "local_project", cwd: "/tmp/private-qa" })],
    dependencies: {
      streamOpenPondHostedChatTurn: async function* (request) {
        requests.push(JSON.stringify(request.messages));
        yield { type: "text_delta", text: requests.length === 1 ? "READY ORCHID" : "REMOTE ORCHID", raw: null };
      },
      ensureCodexRuntime: async () => { throw new Error("Managed OpenPond must not substitute a Native provider."); },
    },
  });
  const messaging = createLocalManagedMessaging({
    store: harness.dependencies.store, getSession: harness.dependencies.getSession,
    latestTurn: id => harness.dependencies.store.latestTurnForSession(id), approvalBlocked: async () => false,
    readiness: createLocalManagedReadiness({
      configProvider: async () => ProviderConfigSchema.parse({ enabled: true, defaultModel: "managed-qa" }),
      codexStatus: async () => { throw new Error("No Native provider readiness required."); },
      openPondStatus: async () => ({ available: accountAvailable, reason: accountAvailable ? null : "Original account changed" }),
    }),
    admit: input => harness.runner.admitUserLocalMessage(input),
  });
  try {
    await harness.runner.sendTurn("session_test", { prompt: "Remember marker ORCHID for this conversation. No tools." });
    const target = await messaging.inspect("session_test");
    expect(target).toMatchObject({ managedSessionId: "session_test", canSendFollowup: true });
    const payload = { authority: "user_click", mode: "followup", prompt: "Recall the marker. No tools.",
      expectedTargetRevision: target.targetRevision, idempotencyKey: "managed-followup" };
    const receipt = await messaging.send("session_test", payload);
    await expect.poll(() => harness.state.turns.length).toBe(2);
    await expect.poll(() => harness.state.turns[1]?.status).toBe("completed");
    expect(requests[1]).toContain("Remember marker ORCHID");
    expect(requests[1]).toContain("READY ORCHID");
    expect(harness.state.turns.every(turn => turn.sessionId === "session_test")).toBe(true);
    expect((await messaging.send("session_test", payload)).id).toBe(receipt.id);
    expect(requests).toHaveLength(2);
    accountAvailable = false;
    await expect(messaging.send("session_test", { ...payload, idempotencyKey: "changed-account" })).rejects.toThrow("Original account changed");
    expect(requests).toHaveLength(2);
  } finally { await harness.runner.close(); }
});

// A typed scorer must not consume old chat as an agent/compaction prompt or
// turn an unrelated language-model reply into successful Decision inference.
test("Decision selection sends one typed request and refuses unverified chat text", async () => {
  const fixture = await decisionScoreFixture(), model = fixture.modelId;
  const requests: any[] = [];
  const harness = createTurnRunnerTestHarness({
    sessions: [turnRunnerTestSession({ provider: "openpond", modelRef: { providerId: "openpond", modelId: model } })],
    events: [event({ sessionId: "session_test", turnId: "old-turn", name: "assistant.delta", source: "provider", output: "Prior ordinary chat context" })],
    dependencies: {
      streamOpenPondHostedChatTurn: async function* (request) {
        requests.push(request);
        if (requests.length === 1) yield { type: "text_delta", text: "An ordinary generated answer", raw: null };
        else yield { type: "text_delta", text: "Scores", raw: { modelId: model, decisionReceipt: await fixture.receipt({
          schemaVersion: "openpond.decisionModelScoreRequest.v1", teamId: "team", versionHash: fixture.version.contentHash,
          requestId: request.requestId!, ...JSON.parse(request.messages[0]!.content),
        }) } };
      },
      ensureCodexRuntime: async () => { throw new Error("A Decision score cannot substitute a native assistant."); },
    },
  });
  const prompt = JSON.stringify({ input: { state: { signal: "blue" }, questions: [{ id: "route", description: "Which route?", type: "choice",
    choices: [{ value: "left", description: "Left" }, { value: "right", description: "Right" }] }] },
    limits: { maximumPromptTokens: 512, maximumForwardTokenWork: 2048, maximumDurationSeconds: 30 } });
  try {
    const result = await harness.runner.sendTurn("session_test", { prompt });
    expect(result.status).toBe("failed");
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([{ role: "user", content: prompt }]);
    expect(requests[0].requestId).toBe(result.id);
    expect(harness.state.events.filter(row => row.turnId === result.id && row.name === "assistant.delta")).toHaveLength(0);
    const completed = await harness.runner.sendTurn("session_test", { prompt });
    expect(completed.status).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual([{ role: "user", content: prompt }]);
    const answer = harness.state.events.find(row => row.turnId === completed.id && row.name === "assistant.delta");
    expect(answer?.data?.decisionScore).toMatchObject({ version: { contentHash: fixture.version.contentHash },
      result: { distributions: [{ questionId: "route", candidates: [{ value: "left", probability: 0.5 }, { value: "right", probability: 0.5 }] }] } });
  } finally { await harness.runner.close(); }
});
