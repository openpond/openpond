import { describe, expect, test } from "bun:test";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import type { Approval, RuntimeEvent, Session, Turn } from "../packages/contracts/src";

describe("BYOK turn runner dispatch", () => {
  test("routes OpenAI-compatible providers through local BYOK stream", async () => {
    let session = baseSession();
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    let capturedStreamInput: {
      providerId: string;
      modelId?: string | null;
      messages: Array<{ role: string; content: string }>;
    } | null = null;

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: {
        async snapshot() {
          return { events, turns };
        },
        async getTurn(turnId) {
          return turns.find((turn) => turn.id === turnId) ?? null;
        },
        async insertTurn(turn) {
          turns.push(turn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((turn) => turn.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]!);
          return turns[index]!;
        },
        async getApproval(approvalId) {
          return approvals.find((approval) => approval.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("no app lookup expected");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be used for BYOK providers");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tool execution should not be needed");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => {
        throw new Error("hosted context usage should not be recorded for BYOK providers");
      },
      streamLocalByokChatTurn: async function* (input) {
        capturedStreamInput = {
          providerId: input.providerId,
          modelId: input.modelId,
          messages: input.messages,
        };
        yield { text: "BYOK hello", raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "hello",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(turn.providerTurnId).toBe(`openrouter-${turn.id}`);
    expect(turn.modelRef).toEqual({ providerId: "openrouter", modelId: "test/model" });
    expect(session.provider).toBe("openrouter");
    expect(capturedStreamInput).toMatchObject({
      providerId: "openrouter",
      modelId: "test/model",
    });
    expect(capturedStreamInput?.messages).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "hello" },
    ]);
    expect(events.some((event) => event.name === "assistant.delta" && event.output === "BYOK hello")).toBe(true);
    expect(events.some((event) => event.name === "turn.completed" && event.source === "provider")).toBe(true);
  });
});

function baseSession(): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "BYOK chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-06-30T10:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
