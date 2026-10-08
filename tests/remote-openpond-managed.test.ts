import { expect, test } from "vitest";
import { ProviderConfigSchema } from "@openpond/contracts";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";
import { createLocalManagedMessaging } from "../apps/server/src/runtime/task-inbox/local-managed-messaging";
import { createLocalManagedReadiness } from "../apps/server/src/runtime/task-inbox/local-managed-readiness";

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
