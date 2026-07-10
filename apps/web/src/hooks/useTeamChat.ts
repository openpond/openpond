import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatAttachment,
  TeamChatAttachment,
  TeamChatEvent,
  TeamChatMessage,
} from "@openpond/contracts";
import type { TeamChatRealtimeSession } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { openTeamChatRealtime } from "../api/team-chat-realtime";
import {
  applyCanonicalMessage,
  applyOptimisticMessage,
  applyTeamChatEvent,
  clearCanonicalPendingMessages,
  createOptimisticMessage,
  markOptimisticMessageFailed,
  mergePendingThreadDetail,
  mergePendingThreadList,
  mergeThreadDetail,
  messageFromEvent,
  removeOptimisticMessage,
  teamChatImageInputs,
  uniqueMessages,
  updateOptimisticDeliveryStatus,
  updateOptimisticUploadProgress,
  updatePendingMessageDelivery,
  updatePendingMessageUploadProgress,
  type PendingAttachmentState,
  type TeamChatState,
} from "./team-chat-state";
import { teamChatErrorMessage } from "../lib/team-chat-error";

const INITIAL_STATE: TeamChatState = {
  members: [],
  threads: [],
  selectedThreadId: null,
  detail: null,
  aiThread: null,
  loading: false,
  busy: false,
  error: null,
};

export function useTeamChat(input: {
  connection: ClientConnection | null;
  teamId: string | null;
  currentUserId: string | null;
}) {
  const [state, setState] = useState<TeamChatState>(INITIAL_STATE);
  const selectedThreadIdRef = useRef<string | null>(null);
  const aiConversationIdRef = useRef<string | null>(null);
  const eventCursorRef = useRef(0);
  const seenEventIdsRef = useRef(new Set<number>());
  const catchupRunningRef = useRef(false);
  const pendingMessagesRef = useRef(new Map<string, TeamChatMessage>());
  const pendingAttachmentsRef = useRef(new Map<string, PendingAttachmentState>());
  const [realtimeSession, setRealtimeSession] = useState<TeamChatRealtimeSession | null>(null);
  const [realtimeBootstrapTeamId, setRealtimeBootstrapTeamId] = useState<string | null>(null);

  const refreshThreads = useCallback(async () => {
    if (!input.connection || !input.teamId) return [];
    const payload = await api.teamChatThreads(input.connection, input.teamId);
    const threads = mergePendingThreadList(payload.threads, pendingMessagesRef.current);
    setState((current) => ({ ...current, threads }));
    return threads;
  }, [input.connection, input.teamId]);

  const refreshThread = useCallback(
    async (threadId?: string | null) => {
      const id = threadId ?? selectedThreadIdRef.current;
      if (!input.connection || !input.teamId || !id) return null;
      const hostedDetail = await api.teamChatThread(input.connection, input.teamId, id);
      clearCanonicalPendingMessages(
        hostedDetail.messages,
        pendingMessagesRef.current,
        pendingAttachmentsRef.current,
      );
      const detail = mergePendingThreadDetail(hostedDetail, pendingMessagesRef.current);
      setState((current) =>
        current.selectedThreadId === id
          ? { ...current, detail: mergeThreadDetail(current.detail, detail) }
          : current,
      );
      if (detail.thread.lastMessageSequence > 0) {
        await api
          .markTeamChatRead(input.connection, id, input.teamId, detail.thread.lastMessageSequence)
          .catch(() => undefined);
      }
      return detail;
    },
    [input.connection, input.teamId],
  );

  const refreshAiThread = useCallback(
    async (conversationId?: string | null) => {
      const id = conversationId ?? aiConversationIdRef.current;
      if (!input.connection || !input.teamId || !id) return null;
      const thread = await api.teamChatAiThread(input.connection, input.teamId, id);
      setState((current) =>
        current.aiThread?.conversationId === id ? { ...current, aiThread: thread } : current,
      );
      return thread;
    },
    [input.connection, input.teamId],
  );

  useEffect(() => {
    selectedThreadIdRef.current = state.selectedThreadId;
  }, [state.selectedThreadId]);

  useEffect(() => {
    aiConversationIdRef.current = state.aiThread?.conversationId ?? null;
  }, [state.aiThread?.conversationId]);

  useEffect(() => {
    if (!input.connection || !input.teamId || !input.currentUserId) {
      setState(INITIAL_STATE);
      setRealtimeSession(null);
      setRealtimeBootstrapTeamId(null);
      pendingAttachmentsRef.current.clear();
      pendingMessagesRef.current.clear();
      seenEventIdsRef.current.clear();
      eventCursorRef.current = 0;
      return;
    }
    let cancelled = false;
    aiConversationIdRef.current = null;
    setRealtimeSession(null);
    setRealtimeBootstrapTeamId(null);
    pendingAttachmentsRef.current.clear();
    pendingMessagesRef.current.clear();
    seenEventIdsRef.current.clear();
    setState((current) => ({ ...current, aiThread: null, loading: true, error: null }));
    void (async () => {
      try {
        const baseline = await api.teamChatEvents(input.connection!, input.teamId!);
        if (cancelled) return;
        eventCursorRef.current = baseline.cursor;
        const membersPromise = api.teamChatMembers(input.connection!, input.teamId!);
        const general = await api.teamChatGeneral(input.connection!, input.teamId!);
        const [members, threads] = await Promise.all([
          membersPromise,
          api.teamChatThreads(input.connection!, input.teamId!),
        ]);
        if (cancelled) return;
        const selectedThreadId =
          selectedThreadIdRef.current &&
          threads.threads.some((thread) => thread.id === selectedThreadIdRef.current)
            ? selectedThreadIdRef.current
            : general.thread.id;
        const detail =
          selectedThreadId === general.thread.id
            ? general
            : await api.teamChatThread(input.connection!, input.teamId!, selectedThreadId);
        if (cancelled) return;
        setState((current) => ({
          ...current,
          members: members.members,
          threads: threads.threads,
          selectedThreadId,
          detail,
          loading: false,
          error: null,
        }));
        setRealtimeBootstrapTeamId(input.teamId!);
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: errorMessage(error),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [input.connection, input.currentUserId, input.teamId]);

  const applyRealtimeEvent = useCallback(
    (event: TeamChatEvent) => {
      if (seenEventIdsRef.current.has(event.id)) return;
      seenEventIdsRef.current.add(event.id);
      if (seenEventIdsRef.current.size > 2000) {
        const oldest = seenEventIdsRef.current.values().next().value;
        if (typeof oldest === "number") seenEventIdsRef.current.delete(oldest);
      }
      const message = messageFromEvent(event);
      if (message?.clientRequestId && !message.id.startsWith("pending:")) {
        pendingMessagesRef.current.delete(message.clientRequestId);
        pendingAttachmentsRef.current.delete(message.clientRequestId);
      }
      setState((current) => applyTeamChatEvent(current, event, input.currentUserId));
      if (event.type === "thread.created") {
        void refreshThreads().catch((error) => {
          setState((current) => ({ ...current, error: errorMessage(error) }));
        });
      }
      if (event.type === "ai_thread.created" || event.type === "ai_turn.updated") {
        if (event.conversationId === aiConversationIdRef.current) {
          void refreshAiThread(event.conversationId).catch((error) => {
            setState((current) => ({ ...current, error: errorMessage(error) }));
          });
        }
      }
      if (
        message &&
        event.type === "message.created" &&
        selectedThreadIdRef.current === message.threadId &&
        message.authorUserId !== input.currentUserId &&
        input.connection &&
        input.teamId
      ) {
        void api
          .markTeamChatRead(input.connection, message.threadId, input.teamId, message.sequence)
          .catch(() => undefined);
      }
    },
    [input.connection, input.currentUserId, input.teamId, refreshAiThread, refreshThreads],
  );

  const catchUpEvents = useCallback(async () => {
    if (!input.connection || !input.teamId || catchupRunningRef.current) return;
    catchupRunningRef.current = true;
    try {
      let hasMore = true;
      while (hasMore) {
        const page = await api.teamChatEvents(input.connection, input.teamId, {
          after: eventCursorRef.current,
          limit: 250,
        });
        for (const event of page.events) applyRealtimeEvent(event);
        eventCursorRef.current = page.cursor;
        hasMore = page.hasMore;
      }
    } finally {
      catchupRunningRef.current = false;
    }
  }, [applyRealtimeEvent, input.connection, input.teamId]);

  useEffect(() => {
    if (!input.connection || !input.teamId || realtimeBootstrapTeamId !== input.teamId) {
      return;
    }
    let cancelled = false;
    let renewalTimer: number | null = null;
    const loadSession = async () => {
      try {
        const session = await api.teamChatRealtimeSession(input.connection!, input.teamId!);
        if (cancelled) return;
        await catchUpEvents();
        if (cancelled) return;
        setRealtimeSession(session);
        const renewIn = Math.max(
          30_000,
          new Date(session.expiresAt).getTime() - Date.now() - 30_000,
        );
        renewalTimer = window.setTimeout(() => void loadSession(), renewIn);
      } catch {
        if (!cancelled) {
          void catchUpEvents().catch(() => undefined);
          renewalTimer = window.setTimeout(() => void loadSession(), 10_000);
        }
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
      if (renewalTimer !== null) window.clearTimeout(renewalTimer);
      setRealtimeSession(null);
    };
  }, [catchUpEvents, input.connection, input.teamId, realtimeBootstrapTeamId]);

  const subscribedThreadIds = state.threads
    .map((thread) => thread.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!realtimeSession) return;
    const realtime = openTeamChatRealtime({
      session: realtimeSession,
      threadIds: subscribedThreadIds ? subscribedThreadIds.split(",") : [],
      onEvent: applyRealtimeEvent,
      onReady: () => {
        void catchUpEvents().catch((error) => {
          setState((current) => ({ ...current, error: errorMessage(error) }));
        });
      },
      onError: () => {
        void catchUpEvents().catch(() => undefined);
      },
    });
    return () => {
      realtime.close();
    };
  }, [applyRealtimeEvent, catchUpEvents, realtimeSession, subscribedThreadIds]);

  useEffect(() => {
    if (!input.connection || !input.teamId || realtimeBootstrapTeamId !== input.teamId) {
      return;
    }
    const catchupTimer = window.setInterval(() => {
      void catchUpEvents().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(catchupTimer);
  }, [catchUpEvents, input.connection, input.teamId, realtimeBootstrapTeamId]);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!input.connection || !input.teamId) return;
      const threadChanged = selectedThreadIdRef.current !== threadId;
      selectedThreadIdRef.current = threadId;
      if (threadChanged) aiConversationIdRef.current = null;
      setState((current) => ({
        ...current,
        selectedThreadId: threadId,
        detail: current.detail?.thread.id === threadId ? current.detail : null,
        aiThread: threadChanged ? null : current.aiThread,
        loading: true,
        error: null,
      }));
      try {
        const hostedDetail = await api.teamChatThread(input.connection, input.teamId, threadId);
        clearCanonicalPendingMessages(
          hostedDetail.messages,
          pendingMessagesRef.current,
          pendingAttachmentsRef.current,
        );
        const detail = mergePendingThreadDetail(hostedDetail, pendingMessagesRef.current);
        setState((current) => ({ ...current, detail, loading: false }));
        await api
          .markTeamChatRead(
            input.connection,
            threadId,
            input.teamId,
            detail.thread.lastMessageSequence,
          )
          .catch(() => undefined);
      } catch (error) {
        setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
      }
    },
    [input.connection, input.teamId],
  );

  const openDm = useCallback(
    async (otherUserId: string) => {
      if (!input.connection || !input.teamId) return null;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const hostedDetail = await api.teamChatDm(input.connection, input.teamId, otherUserId);
        clearCanonicalPendingMessages(
          hostedDetail.messages,
          pendingMessagesRef.current,
          pendingAttachmentsRef.current,
        );
        const detail = mergePendingThreadDetail(hostedDetail, pendingMessagesRef.current);
        const threadChanged = selectedThreadIdRef.current !== detail.thread.id;
        selectedThreadIdRef.current = detail.thread.id;
        if (threadChanged) aiConversationIdRef.current = null;
        setState((current) => ({
          ...current,
          selectedThreadId: detail.thread.id,
          detail,
          aiThread: threadChanged ? null : current.aiThread,
          busy: false,
        }));
        await refreshThreads();
        return detail;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
        return null;
      }
    },
    [input.connection, input.teamId, refreshThreads],
  );

  const loadMoreMessages = useCallback(async (): Promise<boolean> => {
    const detail = state.detail;
    const firstSequence = detail?.messages[0]?.sequence;
    if (
      !input.connection ||
      !input.teamId ||
      !detail ||
      !detail.hasMoreBefore ||
      firstSequence == null
    ) {
      return false;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const older = await api.teamChatThread(input.connection, input.teamId, detail.thread.id, {
        beforeSequence: firstSequence,
        limit: 50,
      });
      setState((current) => {
        if (current.detail?.thread.id !== detail.thread.id) return current;
        const messages = [...older.messages, ...current.detail.messages];
        return {
          ...current,
          loading: false,
          detail: {
            ...current.detail,
            messages: uniqueMessages(messages),
            hasMoreBefore: older.hasMoreBefore,
          },
        };
      });
      return true;
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
      return false;
    }
  }, [input.connection, input.teamId, state.detail]);

  const sendMessage = useCallback(
    async (params: {
      body: string;
      useModel: boolean;
      providerId: string;
      modelId: string;
      mentionUserIds?: string[];
      attachments?: ChatAttachment[];
    }): Promise<boolean> => {
      const threadId = selectedThreadIdRef.current;
      const attachments = teamChatImageInputs(params.attachments ?? []);
      if (!attachments) {
        setState((current) => ({
          ...current,
          error: "Team chat supports up to 10 PNG, JPEG, WebP, or GIF images per message.",
        }));
        return false;
      }
      if (
        !input.connection ||
        !input.teamId ||
        !threadId ||
        (!params.body.trim() && attachments.length === 0)
      ) {
        return false;
      }
      if (params.useModel) {
        if (attachments.length > 0) {
          setState((current) => ({
            ...current,
            error: "Images can be sent to the team thread with Use model turned off.",
          }));
          return false;
        }
        setState((current) => ({ ...current, busy: true, error: null }));
        try {
          const aiThread = await api.createTeamChatAiThread(input.connection, threadId, {
            teamId: input.teamId,
            body: params.body.trim(),
            clientRequestId: crypto.randomUUID(),
            providerId: params.providerId,
            modelId: params.modelId,
          });
          aiConversationIdRef.current = aiThread.conversationId;
          setState((current) => ({ ...current, aiThread }));
          if (aiThread.activeTurn) {
            await api.executeTeamChatAiTurn(input.connection, aiThread.activeTurn.id, input.teamId);
          }
          await Promise.all([refreshThread(threadId), refreshThreads()]);
          setState((current) => ({ ...current, busy: false }));
          return true;
        } catch (error) {
          setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
          return false;
        }
      }

      const clientRequestId = crypto.randomUUID();
      pendingAttachmentsRef.current.set(clientRequestId, {
        inputs: attachments,
        uploaded: null,
      });
      const optimistic = createOptimisticMessage({
        clientRequestId,
        threadId,
        teamId: input.teamId,
        userId: input.currentUserId,
        body: params.body.trim(),
        mentionUserIds: params.mentionUserIds ?? [],
        attachments,
        sequence: (state.detail?.thread.lastMessageSequence ?? 0) + 1,
      });
      pendingMessagesRef.current.set(clientRequestId, optimistic);
      setState((current) => applyOptimisticMessage(current, optimistic));
      try {
        const uploaded: TeamChatAttachment[] = [];
        for (const [index, attachment] of attachments.entries()) {
          uploaded.push(
            await api.uploadTeamChatAttachment(input.connection, threadId, {
              teamId: input.teamId,
              attachment,
            }),
          );
          updatePendingMessageUploadProgress(
            pendingMessagesRef.current,
            clientRequestId,
            `${index + 1} of ${attachments.length}`,
          );
          setState((current) =>
            updateOptimisticUploadProgress(
              current,
              clientRequestId,
              `${index + 1} of ${attachments.length}`,
            ),
          );
        }
        const pending = pendingAttachmentsRef.current.get(clientRequestId);
        if (pending) pending.uploaded = uploaded;
        const message = await api.sendTeamChatMessage(input.connection, threadId, {
          teamId: input.teamId,
          body: params.body.trim(),
          clientRequestId,
          mentionUserIds: params.mentionUserIds,
          attachmentIds: uploaded.map((attachment) => attachment.id),
        });
        pendingAttachmentsRef.current.delete(clientRequestId);
        pendingMessagesRef.current.delete(clientRequestId);
        setState((current) => applyCanonicalMessage(current, message, input.currentUserId));
        return true;
      } catch (error) {
        updatePendingMessageDelivery(pendingMessagesRef.current, clientRequestId, "failed");
        setState((current) => ({
          ...markOptimisticMessageFailed(current, clientRequestId),
          error: errorMessage(error),
        }));
        return true;
      }
    },
    [
      input.connection,
      input.currentUserId,
      input.teamId,
      refreshThread,
      refreshThreads,
      state.detail?.thread.lastMessageSequence,
    ],
  );

  const openAiThread = useCallback(
    async (conversationId: string) => {
      if (!input.connection || !input.teamId) return;
      aiConversationIdRef.current = conversationId;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const aiThread = await api.teamChatAiThread(input.connection, input.teamId, conversationId);
        setState((current) => ({ ...current, aiThread, busy: false }));
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
      }
    },
    [input.connection, input.teamId],
  );

  const closeAiThread = useCallback(() => {
    aiConversationIdRef.current = null;
    setState((current) => ({ ...current, aiThread: null }));
  }, []);

  const sendAiTurn = useCallback(
    async (params: { body: string; providerId: string; modelId: string }): Promise<boolean> => {
      const conversationId = aiConversationIdRef.current;
      if (!input.connection || !input.teamId || !conversationId || !params.body.trim())
        return false;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const aiThread = await api.sendTeamChatAiTurn(input.connection, conversationId, {
          teamId: input.teamId,
          body: params.body.trim(),
          clientRequestId: crypto.randomUUID(),
          providerId: params.providerId,
          modelId: params.modelId,
        });
        setState((current) => ({ ...current, aiThread, busy: false }));
        if (aiThread.activeTurn) {
          await api.executeTeamChatAiTurn(input.connection, aiThread.activeTurn.id, input.teamId);
        }
        return true;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId],
  );

  const stopAiTurn = useCallback(async (): Promise<boolean> => {
    const turnId = state.aiThread?.activeTurn?.id;
    if (!input.connection || !input.teamId || !turnId) return false;
    const result = await api.cancelTeamChatAiTurnExecution(input.connection, turnId, input.teamId);
    return result.cancelled;
  }, [input.connection, input.teamId, state.aiThread?.activeTurn?.id]);

  const editMessage = useCallback(
    async (message: TeamChatMessage, body: string) => {
      if (!input.connection || !input.teamId) return false;
      try {
        await api.editTeamChatMessage(input.connection, message.threadId, message.id, {
          teamId: input.teamId,
          body,
        });
        await refreshThread(message.threadId);
        return true;
      } catch (error) {
        setState((current) => ({ ...current, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId, refreshThread],
  );

  const deleteMessage = useCallback(
    async (message: TeamChatMessage) => {
      if (!input.connection || !input.teamId) return false;
      try {
        await api.deleteTeamChatMessage(
          input.connection,
          message.threadId,
          message.id,
          input.teamId,
        );
        await refreshThread(message.threadId);
        return true;
      } catch (error) {
        setState((current) => ({ ...current, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId, refreshThread],
  );

  const retryMessage = useCallback(
    async (message: TeamChatMessage): Promise<boolean> => {
      if (
        !input.connection ||
        !input.teamId ||
        !message.clientRequestId ||
        !message.id.startsWith("pending:")
      ) {
        return false;
      }
      const mentionUserIds = Array.isArray(message.metadata.mentionUserIds)
        ? message.metadata.mentionUserIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const pendingAttachments = pendingAttachmentsRef.current.get(message.clientRequestId);
      updatePendingMessageDelivery(pendingMessagesRef.current, message.clientRequestId, "sending");
      setState((current) =>
        updateOptimisticDeliveryStatus(current, message.clientRequestId!, "sending"),
      );
      try {
        let uploaded = pendingAttachments?.uploaded ?? [];
        if (pendingAttachments && !pendingAttachments.uploaded) {
          uploaded = [];
          for (const [index, attachment] of pendingAttachments.inputs.entries()) {
            uploaded.push(
              await api.uploadTeamChatAttachment(input.connection, message.threadId, {
                teamId: input.teamId,
                attachment,
              }),
            );
            updatePendingMessageUploadProgress(
              pendingMessagesRef.current,
              message.clientRequestId,
              `${index + 1} of ${pendingAttachments.inputs.length}`,
            );
            setState((current) =>
              updateOptimisticUploadProgress(
                current,
                message.clientRequestId!,
                `${index + 1} of ${pendingAttachments.inputs.length}`,
              ),
            );
          }
          pendingAttachments.uploaded = uploaded;
        }
        const canonical = await api.sendTeamChatMessage(input.connection, message.threadId, {
          teamId: input.teamId,
          body: message.body,
          clientRequestId: message.clientRequestId,
          mentionUserIds,
          attachmentIds: uploaded.map((attachment) => attachment.id),
        });
        pendingAttachmentsRef.current.delete(message.clientRequestId);
        pendingMessagesRef.current.delete(message.clientRequestId);
        setState((current) => applyCanonicalMessage(current, canonical, input.currentUserId));
        return true;
      } catch (error) {
        updatePendingMessageDelivery(pendingMessagesRef.current, message.clientRequestId, "failed");
        setState((current) => ({
          ...updateOptimisticDeliveryStatus(current, message.clientRequestId!, "failed"),
          error: errorMessage(error),
        }));
        return false;
      }
    },
    [input.connection, input.currentUserId, input.teamId],
  );

  const dismissFailedMessage = useCallback((message: TeamChatMessage) => {
    if (!message.id.startsWith("pending:")) return;
    if (message.clientRequestId) pendingAttachmentsRef.current.delete(message.clientRequestId);
    if (message.clientRequestId) pendingMessagesRef.current.delete(message.clientRequestId);
    setState((current) => removeOptimisticMessage(current, message.id));
  }, []);

  return {
    ...state,
    currentUserId: input.currentUserId,
    selectThread,
    openDm,
    loadMoreMessages,
    sendMessage,
    openAiThread,
    closeAiThread,
    sendAiTurn,
    stopAiTurn,
    editMessage,
    deleteMessage,
    retryMessage,
    dismissFailedMessage,
    refresh: async () => {
      await Promise.all([refreshThreads(), refreshThread(), refreshAiThread()]);
    },
  };
}

function errorMessage(error: unknown): string {
  return teamChatErrorMessage(error);
}
