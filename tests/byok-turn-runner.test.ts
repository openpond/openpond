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

  test("allows concurrent turns in different sessions while rejecting duplicate turns in one session", async () => {
    const sessions = new Map<string, Session>([
      ["session_1", baseSession()],
      ["session_2", baseSession({ id: "session_2", title: "Second BYOK chat" })],
    ]);
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const firstStreamStarted = deferred();
    const secondStreamStarted = deferred();
    const releaseStreams = deferred();
    let streamStarts = 0;

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
      getSession: async (sessionId) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        return session;
      },
      updateSession: async (sessionId, patch) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        const next = { ...session, ...patch };
        sessions.set(sessionId, next);
        return next;
      },
      completeTurn: async (sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        const session = sessions.get(sessionId);
        if (session) sessions.set(sessionId, { ...session, status: "idle" });
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
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        streamStarts += 1;
        if (streamStarts === 1) firstStreamStarted.resolve();
        if (streamStarts === 2) secondStreamStarted.resolve();
        await releaseStreams.promise;
        const turn = turns.find((candidate) => candidate.id === input.requestId);
        yield { text: `BYOK done ${turn?.sessionId ?? "unknown"}`, raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-concurrent" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const firstTurnPromise = runner.sendTurn("session_1", {
      prompt: "first",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await firstStreamStarted.promise;

    await expect(
      runner.sendTurn("session_1", {
        prompt: "duplicate",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      }),
    ).rejects.toThrow("A turn is already running for this chat.");

    const secondTurnPromise = runner.sendTurn("session_2", {
      prompt: "second",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await secondStreamStarted.promise;

    releaseStreams.resolve();
    const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);

    expect(firstTurn.status).toBe("completed");
    expect(secondTurn.status).toBe("completed");
    expect(streamStarts).toBe(2);
    expect(turns.map((turn) => turn.prompt).sort()).toEqual(["first", "second"]);
    expect(events.some((event) => event.sessionId === "session_1" && event.output === "BYOK done session_1")).toBe(true);
    expect(events.some((event) => event.sessionId === "session_2" && event.output === "BYOK done session_2")).toBe(true);
  });

  test("allows a follow-up turn after interrupting a still-unwinding active turn", async () => {
    let session = baseSession();
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const firstStreamStarted = deferred();
    const secondStreamStarted = deferred();
    const releaseFirstStream = deferred();

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
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        const turn = turns.find((candidate) => candidate.id === input.requestId);
        if (turn?.prompt === "first") {
          firstStreamStarted.resolve();
          await releaseFirstStream.promise;
        } else {
          secondStreamStarted.resolve();
        }
        yield { text: `BYOK done ${turn?.prompt ?? "unknown"}`, raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-interrupt" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const firstTurnPromise = runner.sendTurn("session_1", {
      prompt: "first",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await firstStreamStarted.promise;

    const interrupted = await runner.interruptSessionTurn("session_1");
    expect(interrupted.status).toBe("interrupted");

    const secondTurnPromise = runner.sendTurn("session_1", {
      prompt: "second",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await secondStreamStarted.promise;

    releaseFirstStream.resolve();
    const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);

    expect(firstTurn.status).toBe("interrupted");
    expect(secondTurn.status).toBe("completed");
    expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function baseSession(overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  };
}
