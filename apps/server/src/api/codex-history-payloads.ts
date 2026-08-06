import {
  PatchSessionRequestSchema,
  SendTurnRequestSchema,
  type Session,
} from "@openpond/contracts";
import { CodexAppServerClient, defaultServerRequestResult } from "@openpond/codex-provider";
import {
  chatAttachmentContext,
  formatPromptWithAttachmentContext,
  materializeChatAttachments,
} from "../chat-attachments.js";
import {
  readCodexHistoryThreadPayload,
  readCodexHistoryThreadRevision,
} from "../codex-history.js";
import {
  applyCodexHistorySidebarPreference,
  loadCodexHistorySidebarPreferences,
  patchCodexHistorySidebarPreference,
} from "../codex-history-sidebar-preferences.js";
import type { SqliteStore } from "../store/store.js";
import {
  codexHistorySessionConfig,
  codexHistorySessionWithLiveStatus,
  codexHistoryThreadReadOptions,
  nextCodexHistoryTurnId,
  type ActiveCodexHistoryTurn,
  type CodexHistoryTurnInterruptResponse,
} from "./server-payload-helpers.js";

export function createCodexHistoryPayloads(input: {
  attachmentRootDir: string;
  store: SqliteStore;
  version: string;
}) {
  const activeTurns = new Map<string, ActiveCodexHistoryTurn>();

  function turnIsActive(sessionId: string): boolean {
    const activeTurn = activeTurns.get(sessionId);
    return Boolean(activeTurn && !activeTurn.settled);
  }

  function sessionsWithLiveStatus(sessions: Session[]): Session[] {
    return sessions.map((session) =>
      codexHistorySessionWithLiveStatus(session, turnIsActive(session.id)),
    );
  }

  async function threadPayload(sessionId: string, requestUrl?: URL): Promise<unknown> {
    const incremental = requestUrl?.searchParams.get("incremental") === "1";
    const requestedRevision = requestUrl?.searchParams.get("revision") ?? null;
    const revisionBeforeRead = incremental
      ? (await readCodexHistoryThreadRevision(sessionId)).revision
      : null;
    const liveRevisionBeforeRead = revisionBeforeRead
      ? `${revisionBeforeRead}:${turnIsActive(sessionId) ? "active" : "idle"}`
      : null;
    if (requestedRevision && requestedRevision === liveRevisionBeforeRead) {
      return { unchanged: true, revision: liveRevisionBeforeRead };
    }
    const [payload, preferences] = await Promise.all([
      readCodexHistoryThreadPayload(sessionId, {
        ...codexHistoryThreadReadOptions(requestUrl),
        attachmentRootDir: input.attachmentRootDir,
      }),
      loadCodexHistorySidebarPreferences(input.store),
    ]);
    const session = applyCodexHistorySidebarPreference(payload.session, preferences);
    const resolvedPayload = {
      ...payload,
      session: codexHistorySessionWithLiveStatus(session, turnIsActive(sessionId)),
    };
    if (!incremental) return resolvedPayload;
    const revisionAfterRead = (await readCodexHistoryThreadRevision(sessionId)).revision;
    const liveRevisionAfterRead = `${revisionAfterRead}:${turnIsActive(sessionId) ? "active" : "idle"}`;
    const afterEventId = requestUrl?.searchParams.get("afterEventId") ?? null;
    const afterIndex = afterEventId
      ? resolvedPayload.events.findIndex((event) => event.id === afterEventId)
      : -1;
    const reset = Boolean(afterEventId && afterIndex < 0);
    return {
      unchanged: false,
      revision: liveRevisionAfterRead,
      reset,
      session: resolvedPayload.session,
      events: afterEventId && afterIndex >= 0
        ? resolvedPayload.events.slice(afterIndex + 1)
        : resolvedPayload.events,
    };
  }

  async function patchSessionPayload(sessionId: string, payload: unknown): Promise<unknown> {
    PatchSessionRequestSchema.parse(payload);
    const current = await readCodexHistoryThreadPayload(sessionId, {
      attachmentRootDir: input.attachmentRootDir,
    });
    await patchCodexHistorySidebarPreference(input.store, sessionId, payload);
    return codexHistorySessionWithLiveStatus(
      applyCodexHistorySidebarPreference(
        current.session,
        await loadCodexHistorySidebarPreferences(input.store),
      ),
      turnIsActive(sessionId),
    );
  }

  async function sendTurnPayload(sessionId: string, payload: unknown): Promise<unknown> {
    const turnInput = SendTurnRequestSchema.parse(payload);
    if (activeTurns.has(sessionId)) {
      throw new Error("A Codex history turn is already running for this chat.");
    }
    const current = await readCodexHistoryThreadPayload(sessionId, {
      attachmentRootDir: input.attachmentRootDir,
    });
    const threadId = current.session.codexThreadId;
    if (!threadId) throw new Error("Codex history session is missing its Codex thread id");
    const cwd = turnInput.cwd ?? current.session.cwd;
    const turnId = nextCodexHistoryTurnId(current.session.id);
    const attachmentContexts = await materializeChatAttachments({
      attachmentRootDir: input.attachmentRootDir,
      sessionId: current.session.id,
      turnId,
      attachments: turnInput.attachments,
    });
    const providerPrompt = formatPromptWithAttachmentContext(
      turnInput.prompt,
      chatAttachmentContext(attachmentContexts),
    );
    const client = new CodexAppServerClient({
      binaryPath: process.env.CODEX_BINARY || "codex",
      clientName: "openpond-app",
      clientTitle: "OpenPond App",
      clientVersion: input.version,
      onNotification: () => undefined,
      onServerRequest: async (request) => defaultServerRequestResult(request),
    });
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const activeTurn: ActiveCodexHistoryTurn = {
      client,
      completion: null,
      interrupted: false,
      ready,
      resolveReady,
      settled: false,
      threadId,
      turnId: null,
    };
    activeTurns.set(sessionId, activeTurn);
    try {
      await client.resumeThread({
        threadId,
        cwd,
        approvalPolicy: turnInput.approvalPolicy,
        sandbox: turnInput.sandbox,
        config: codexHistorySessionConfig(turnInput.codexPermissionMode),
      });
      const turn = await client.startTurn({
        threadId,
        prompt: providerPrompt,
        cwd,
        model: turnInput.model,
        approvalPolicy: turnInput.approvalPolicy,
        sandbox: turnInput.sandbox,
      });
      const completion = client.waitForTurn(turn.turnId);
      activeTurn.completion = completion;
      activeTurn.turnId = turn.turnId;
      activeTurn.resolveReady();
      try {
        await completion;
      } catch (error) {
        if (!activeTurn.interrupted) throw error;
      }
      activeTurn.settled = true;
      return threadPayload(sessionId);
    } finally {
      activeTurn.settled = true;
      activeTurn.resolveReady();
      if (activeTurns.get(sessionId) === activeTurn) activeTurns.delete(sessionId);
      await client.stop().catch(() => undefined);
    }
  }

  async function interruptTurnPayload(
    sessionId: string,
  ): Promise<CodexHistoryTurnInterruptResponse> {
    const activeTurn = activeTurns.get(sessionId);
    if (!activeTurn) return { interrupted: false, reason: "no_active_openpond_turn" };
    activeTurn.interrupted = true;
    await activeTurn.ready;
    if (!activeTurn.turnId || !activeTurn.completion) {
      await activeTurn.client.stop().catch(() => undefined);
      return { interrupted: false, reason: "turn_not_ready" };
    }
    await activeTurn.client.interruptTurn({
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    });
    await activeTurn.completion.catch(() => undefined);
    return { interrupted: true };
  }

  return {
    interruptCodexHistoryTurnPayload: interruptTurnPayload,
    patchCodexHistorySessionPayload: patchSessionPayload,
    sendCodexHistoryTurnPayload: sendTurnPayload,
    codexHistorySessionsWithLiveStatus: sessionsWithLiveStatus,
    codexHistoryThreadPayload: threadPayload,
  };
}
