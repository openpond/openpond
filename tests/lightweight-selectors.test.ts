import { describe, expect, test } from "vitest";

import { managedRlBaseProfileForModel, MANAGED_RL_BASE_PROFILE, resolveManagedRlBaseProfile } from "../apps/server/src/training/managed-rl-base-profile.ts";
import { normalizeModelUsageTokens } from "../apps/server/src/runtime/model-usage-normalization";
import { browserRevealDecision } from "../apps/web/src/hooks/useBrowserRevealRequests";
import { shortProfileAgentLabel } from "../apps/web/src/lib/profile-agent-labels";
import { insertVoiceTranscript } from "../apps/web/src/lib/voice-text";
import { accountToken } from "../packages/runtime/src/selectors";

describe("small runtime selectors", () => {
  test("chooses explicit account credentials before process credentials", () => {
    expect(accountToken(null, { OPENPOND_API_KEY: " hosted-key " })).toBe("hosted-key");
    expect(accountToken(
      { handle: "selected", apiKey: "account-key" },
      { OPENPOND_API_KEY: "hosted-key" },
    )).toBe("account-key");
  });

  test("normalizes provider token usage shapes", () => {
    expect(normalizeModelUsageTokens({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }))
      .toEqual({ promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });
    expect(normalizeModelUsageTokens({ inputTokens: "42", outputTokens: 8 }))
      .toEqual({ promptTokens: 42, completionTokens: 8, totalTokens: 50 });
    expect(normalizeModelUsageTokens({ totalTokens: 77 }))
      .toEqual({ promptTokens: null, completionTokens: null, totalTokens: 77 });
    expect(normalizeModelUsageTokens(null))
      .toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  test("resolves only the qualified managed RL base profile", () => {
    expect(managedRlBaseProfileForModel("Qwen/Qwen3-0.6B")).toEqual(MANAGED_RL_BASE_PROFILE);
    expect(managedRlBaseProfileForModel("Qwen/Qwen3-8B")).toBeNull();
    expect(resolveManagedRlBaseProfile({
      schemaVersion: "openpond.baseModelPreference.v1",
      modelId: MANAGED_RL_BASE_PROFILE.modelId,
      revision: MANAGED_RL_BASE_PROFILE.revision,
      tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
      chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
      modelAssetId: null,
      source: "managed",
    })).toEqual(MANAGED_RL_BASE_PROFILE);
  });

  test("decides whether a browser reveal needs to switch sessions", () => {
    expect(browserRevealDecision({
      currentConversationId: "session_1",
      requestConversationId: "session_1",
      sessionIds: ["session_1", "session_2"],
    })).toEqual({ reveal: true, sessionIdToOpen: null });
    expect(browserRevealDecision({
      currentConversationId: "session_1",
      requestConversationId: "session_2",
      sessionIds: ["session_1", "session_2"],
    })).toEqual({ reveal: true, sessionIdToOpen: "session_2" });
    expect(browserRevealDecision({
      currentConversationId: "session_1",
      requestConversationId: "draft:unknown",
      sessionIds: ["session_1", "session_2"],
    })).toEqual({ reveal: false, sessionIdToOpen: null });
  });

  test("formats generated labels without truncating plural names", () => {
    expect(shortProfileAgentLabel({ actionId: "business-ops-router.chat", label: "Chat" }))
      .toBe("Business Ops Router");
    expect(shortProfileAgentLabel({ actionId: "sales-pipeline-followup.chat", label: "Chat" }))
      .toBe("Sales Pipeline Followup");
  });

  test("inserts normalized voice transcripts at the cursor", () => {
    expect(insertVoiceTranscript("Refactor this", "using the helper", 8))
      .toEqual({ value: "Refactor using the helper this", cursorIndex: 25 });
    expect(insertVoiceTranscript("Start  end", "middle", 6))
      .toEqual({ value: "Start middle end", cursorIndex: 12 });
    expect(insertVoiceTranscript("", "  fix   JSON   parsing  ", 0))
      .toEqual({ value: "fix JSON parsing", cursorIndex: 16 });
  });
});
