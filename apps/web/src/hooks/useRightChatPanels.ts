import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type {
  AppPreferences,
  ChatAttachment,
  ChatProvider,
  OpenPondCommandAccessMode,
  ProviderSettings,
  RuntimeEvent,
  Session,
} from "@openpond/contracts";
import type { ClientConnection } from "../api";
import type { RightChatPanel, RightPanelMode, ShowAppToast } from "../app/app-state";
import type { ComposerSubmitOptions } from "../components/chat/Composer";
import type { WorkspaceDiffTabRequest } from "../components/workspace-diff/workspace-diff-panel-model";
import type { ComposerSlashCommand } from "../lib/composer-slash-commands";
import type { AppView, LabsTab } from "../lib/app-models";
import { normalizeChatModel } from "../lib/app-models";
import { appendPendingUserChatMessage, type PendingChatUserMessage } from "../lib/pending-chat-messages";
import { appendSubagentRightChatPanels, createRightChatPanel, newlyObservedSubagentSessions } from "../lib/right-chat-panels";
import { loadCodexHistoryThreadPayload } from "../lib/codex-history-thread-cache";
import {
  buildRuntimeIndexes,
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
  latestPendingApprovalForSession,
  runtimeEventsForSession,
} from "../lib/runtime-indexes";
import { buildCachedChatMessages } from "../lib/chat-messages";
import { contextWindowStatusFromUsage } from "../lib/context-window";
import {
  codexHistoryPayloadWithLiveStatus,
  subscribeCodexHistoryLiveRefresh,
} from "../lib/codex-history-live-refresh";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { latestTurnCompletionState } from "../lib/turn-completion-state";
import { hasGitHubIssueSubmitConnection, buildSubmitIssueSlashPrompt } from "../lib/submit-issue-command";
import { isCloudWorkspaceKind } from "../lib/workspace-location";
import { localPathWorkspaceId } from "@openpond/contracts";
import type { SandboxActionCatalogEntry } from "../lib/sandbox-types";
import type { ConnectedAppMentionOption } from "../lib/connected-app-mentions";
import { mergeRuntimeEventLists } from "../lib/runtime-event-lists";
import type { useChatActions } from "./useChatActions";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

function promptForRightChatCommand(command: ComposerSlashCommand, prompt: string): string {
  const args = prompt.trim();
  if (command.id === "create") return `/create ${args}`;
  if (command.id === "edit") return `/edit ${args}`;
  if (command.id === "skill") return `/skill ${args}`;
  if (command.id === "submit-issue") return buildSubmitIssueSlashPrompt(args);
  return `Goal: ${args}`;
}

type RightChatInsights = {
  runScan: () => Promise<{ summary?: { activeCount?: number } } | null>;
  summary: { activeCount?: number } | null;
};

export function useRightChatPanels(input: {
  activeModel: string;
  activeProvider: RightChatPanel["provider"];
  applyRightCodexHistoryPayload: (
    payload: Awaited<ReturnType<typeof loadCodexHistoryThreadPayload>>,
  ) => void;
  codexHistoryEvents: RuntimeEvent[];
  connectedAppMentions: ConnectedAppMentionOption[];
  connection: ClientConnection | null;
  contextCompaction: AppPreferences["contextCompaction"];
  insights: RightChatInsights;
  locallyActiveCodexHistorySessionIds: ReadonlySet<string>;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  pendingChatUserMessages: Record<string, PendingChatUserMessage>;
  providerSettings: ProviderSettings | null;
  rightChatHistoryEvents: Record<string, RuntimeEvent[]>;
  rightChatPanels: RightChatPanel[];
  rightPanelMode: RightPanelMode;
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  runningSessionIds: ReadonlySet<string>;
  selectedSession: Session | null;
  selectedSessionId: string | null;
  sendPrompt: ReturnType<typeof useChatActions>["sendPrompt"];
  setDiffPanelOpen: Dispatch<SetStateAction<boolean>>;
  setDraftModel: Dispatch<SetStateAction<string>>;
  setDraftProvider: Dispatch<SetStateAction<ChatProvider>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setRightChatHistoryEvents: Dispatch<SetStateAction<Record<string, RuntimeEvent[]>>>;
  setRightChatPanels: Dispatch<SetStateAction<RightChatPanel[]>>;
  setRightPanelMode: Dispatch<SetStateAction<RightPanelMode>>;
  setRightPanelTabRequest: Dispatch<SetStateAction<WorkspaceDiffTabRequest | null>>;
  setLabsTab: Dispatch<SetStateAction<LabsTab>>;
  setView: Dispatch<SetStateAction<AppView>>;
  showChangesPanel: () => void;
  showToast: ShowAppToast;
  sidebarSessions: Session[];
  startupReady: boolean;
}) {
  const {
    activeModel,
    activeProvider,
    applyRightCodexHistoryPayload,
    codexHistoryEvents,
    connectedAppMentions,
    connection,
    contextCompaction,
    insights,
    locallyActiveCodexHistorySessionIds,
    openPondCommandAccessMode,
    pendingChatUserMessages,
    providerSettings,
    rightChatHistoryEvents,
    rightChatPanels,
    rightPanelMode,
    runtimeIndexes,
    runningSessionIds,
    selectedSession,
    selectedSessionId,
    sendPrompt,
    setDiffPanelOpen,
    setDraftModel,
    setDraftProvider,
    setError,
    setRightChatHistoryEvents,
    setRightChatPanels,
    setRightPanelMode,
    setRightPanelTabRequest,
    setLabsTab,
    setView,
    showChangesPanel,
    showToast,
    sidebarSessions,
    startupReady,
  } = input;
  const knownSubagentChildSessionIdsRef = useRef<Set<string> | null>(null);
  const pendingAutoDockSubagentSessionsRef = useRef<Map<string, Session>>(new Map());

  const showRightPanelDiffTab = useCallback(
    (tab: WorkspaceDiffTabRequest["tab"]) => {
      setRightPanelTabRequest((current) => ({ id: (current?.id ?? 0) + 1, tab }));
      showChangesPanel();
    },
    [showChangesPanel],
  );
  const openRightChatPanel = useCallback(
    (session: Session | null = null) => {
      const nextPanel = createRightChatPanel({
        sessionId: session?.id ?? null,
        provider: session?.provider ?? activeProvider,
        model: session?.modelRef?.modelId ?? activeModel,
      });
      setRightChatPanels((current) => {
        if (session?.id && current.some((panel) => panel.sessionId === session.id)) return current;
        return [...current, nextPanel];
      });
      setDiffPanelOpen(true);
      setRightPanelMode("chat");
      setView("chat");
    },
    [activeModel, activeProvider, setDiffPanelOpen, setRightChatPanels, setRightPanelMode, setView],
  );
  useEffect(() => {
    if (!startupReady) return;

    const knownSessionIds = knownSubagentChildSessionIdsRef.current;
    if (!knownSessionIds) {
      knownSubagentChildSessionIdsRef.current = new Set(
        sidebarSessions
          .filter((session) => Boolean(session.parentSessionId && session.subagentRunId))
          .map((session) => session.id),
      );
      return;
    }

    const observed = newlyObservedSubagentSessions({
      sessions: sidebarSessions,
      knownSessionIds,
    });
    knownSubagentChildSessionIdsRef.current = observed.knownSessionIds;
    for (const session of observed.newSessions) {
      pendingAutoDockSubagentSessionsRef.current.set(session.id, session);
    }

    const activeParentSessionId = selectedSession?.parentSessionId ?? selectedSession?.id ?? null;
    if (!activeParentSessionId) return;
    const pendingForParent = [...pendingAutoDockSubagentSessionsRef.current.values()].filter(
      (session) => session.parentSessionId === activeParentSessionId,
    );
    if (pendingForParent.length === 0) return;

    for (const session of pendingForParent) {
      pendingAutoDockSubagentSessionsRef.current.delete(session.id);
    }
    setRightChatPanels((current) => appendSubagentRightChatPanels(current, pendingForParent));
    setDiffPanelOpen(true);
    setRightPanelMode("chat");
  }, [
    selectedSession?.id,
    selectedSession?.parentSessionId,
    setDiffPanelOpen,
    setRightChatPanels,
    setRightPanelMode,
    sidebarSessions,
    startupReady,
  ]);
  const showRightChatPanel = useCallback(() => {
    if (rightChatPanels.length === 0) {
      openRightChatPanel(null);
      return;
    }
    setDiffPanelOpen(true);
    setRightPanelMode("chat");
    setView("chat");
  }, [openRightChatPanel, rightChatPanels.length, setDiffPanelOpen, setRightPanelMode, setView]);
  const closeRightChatPanel = useCallback(
    (panelId: string) => {
      const closesLastPanel =
        rightChatPanels.length <= 1 && rightChatPanels.some((panel) => panel.id === panelId);
      const removePanel = () => {
        setRightChatPanels((current) => current.filter((panel) => panel.id !== panelId));
      };
      if (closesLastPanel && rightPanelMode === "chat") {
        showRightPanelDiffTab("files");
        if (typeof window === "undefined") {
          removePanel();
          return;
        }
        window.requestAnimationFrame(removePanel);
        return;
      }
      removePanel();
    },
    [rightChatPanels, rightPanelMode, setRightChatPanels, showRightPanelDiffTab],
  );
  const updateRightChatPrompt = useCallback(
    (panelId: string, nextPrompt: string) => {
      setRightChatPanels((current) =>
        current.map((panel) => (panel.id === panelId ? { ...panel, prompt: nextPrompt } : panel)),
      );
    },
    [setRightChatPanels],
  );
  const updateRightChatModel = useCallback(
    (panelId: string, model: string) => {
      const panel = rightChatPanels.find((candidate) => candidate.id === panelId);
      if (panel) {
        setDraftProvider(panel.provider);
        setDraftModel(model);
      }
      setRightChatPanels((current) =>
        current.map((panel) => (panel.id === panelId ? { ...panel, model } : panel)),
      );
    },
    [rightChatPanels, setDraftModel, setDraftProvider, setRightChatPanels],
  );
  const updateRightChatProvider = useCallback(
    (panelId: string, provider: RightChatPanel["provider"]) => {
      const panel = rightChatPanels.find((candidate) => candidate.id === panelId);
      const model = normalizeChatModel(provider, panel?.model, providerSettings);
      if (panel) {
        setDraftProvider(provider);
        setDraftModel(model);
      }
      setRightChatPanels((current) =>
        current.map((panel) =>
          panel.id === panelId
            ? {
                ...panel,
                provider,
                model: normalizeChatModel(provider, panel.model, providerSettings),
              }
            : panel,
        ),
      );
    },
    [providerSettings, rightChatPanels, setDraftModel, setDraftProvider, setRightChatPanels],
  );
  const rightCodexHistorySessionKey = useMemo(() => {
    const seen = new Set<string>();
    const sessionIds: string[] = [];
    for (const panel of rightChatPanels) {
      if (
        !isCodexHistorySessionId(panel.sessionId) ||
        !panel.sessionId ||
        seen.has(panel.sessionId)
      )
        continue;
      seen.add(panel.sessionId);
      sessionIds.push(panel.sessionId);
    }
    return sessionIds.join("\n");
  }, [rightChatPanels]);
  const rightCodexHistoryActiveSessionKey = useMemo(() => {
    if (!rightCodexHistorySessionKey) return "";
    const panelSessionIds = new Set(rightCodexHistorySessionKey.split("\n").filter(Boolean));
    return sidebarSessions
      .filter((session) => panelSessionIds.has(session.id) && session.status === "active")
      .map((session) => session.id)
      .join("\n");
  }, [rightCodexHistorySessionKey, sidebarSessions]);
  const rightCodexHistoryLocallyActiveSessionKey = useMemo(() => {
    if (!rightCodexHistorySessionKey) return "";
    return rightCodexHistorySessionKey
      .split("\n")
      .filter((sessionId) => locallyActiveCodexHistorySessionIds.has(sessionId))
      .join("\n");
  }, [locallyActiveCodexHistorySessionIds, rightCodexHistorySessionKey]);

  useEffect(() => {
    if (!connection || !rightCodexHistorySessionKey) return undefined;

    const historyConnection = connection;
    const sessionIds = rightCodexHistorySessionKey.split("\n").filter(Boolean);
    const reportedActiveSessionIds = new Set(
      rightCodexHistoryActiveSessionKey.split("\n").filter(Boolean),
    );
    const locallyActiveSessionIds = new Set(
      rightCodexHistoryLocallyActiveSessionKey.split("\n").filter(Boolean),
    );

    const unsubscribers = sessionIds.map((sessionId) =>
      subscribeCodexHistoryLiveRefresh({
        connection: historyConnection,
        locallyActive: locallyActiveSessionIds.has(sessionId),
        onError: (historyError) =>
          setError(historyError instanceof Error ? historyError.message : String(historyError)),
        onPayload: (payload) =>
          applyRightCodexHistoryPayload(
            codexHistoryPayloadWithLiveStatus(
              payload,
              locallyActiveSessionIds.has(sessionId),
            ),
          ),
        reportedActive: reportedActiveSessionIds.has(sessionId),
        sessionId,
        surface: "thread",
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [
    applyRightCodexHistoryPayload,
    connection,
    rightCodexHistoryActiveSessionKey,
    rightCodexHistoryLocallyActiveSessionKey,
    rightCodexHistorySessionKey,
    setError,
  ]);

  const rightChatPanelViews = useMemo(() => {
    const sessionById = new Map(sidebarSessions.map((session) => [session.id, session]));
    return rightChatPanels.map((panel) => {
      const session = panel.sessionId ? (sessionById.get(panel.sessionId) ?? null) : null;
      const provider = session?.provider ?? panel.provider;
      const isHistoryPanel = isCodexHistorySessionId(panel.sessionId);
      const panelEvents = isHistoryPanel
        ? ((panel.sessionId ? rightChatHistoryEvents[panel.sessionId] : undefined) ??
          (panel.sessionId === selectedSessionId ? codexHistoryEvents : EMPTY_RUNTIME_EVENTS))
        : runtimeEventsForSession(runtimeIndexes, panel.sessionId);
      const panelIndexes = isHistoryPanel ? buildRuntimeIndexes(panelEvents, []) : runtimeIndexes;
      const panelTurnCompletionState = latestTurnCompletionState(panelEvents);
      const panelPendingApproval = latestPendingApprovalForSession(panelIndexes, panel.sessionId);
      const panelRunning = Boolean(
        session &&
        (runningSessionIds.has(session.id) ||
          (!session.systemKind &&
            session.status === "active" &&
            panelTurnCompletionState === "pending")),
      );
      const contextWindowStatusForPanel = contextWindowStatusFromUsage({
        provider,
        snapshot: latestContextUsageForSession(panelIndexes, panel.sessionId),
        preferences: contextCompaction,
      });
      const workspaceRootPath = session?.cwd ?? null;
      const activeWorkspaceAppIdForPanel =
        session?.appId ??
        session?.localProjectId ??
        (session?.workspaceKind === "local_project" ? (session.workspaceId ?? null) : null) ??
        (session?.cwd && !isCloudWorkspaceKind(session.workspaceKind)
          ? localPathWorkspaceId(session.cwd)
          : null);
      const panelMessages = buildCachedChatMessages(panelEvents);
      return {
        ...panel,
        session,
        title: session?.title ?? "New task",
        messages: appendPendingUserChatMessage(
          panelMessages,
          panel.sessionId ? pendingChatUserMessages[panel.sessionId] : null,
        ),
        contextWindowStatus: contextWindowStatusForPanel,
        goalRuntime: latestGoalRuntimeForSession(panelIndexes, panel.sessionId),
        pendingApproval: panelPendingApproval,
        running: panelRunning,
        steerAutoDispatchBlocked:
          Boolean(panelPendingApproval) || panelTurnCompletionState === "blocked",
        steerAutoDispatchReady:
          panelTurnCompletionState === "completed" && !panelPendingApproval && !panelRunning,
        workspaceRootPath,
        activeWorkspaceAppId: activeWorkspaceAppIdForPanel,
      };
    });
  }, [
    codexHistoryEvents,
    rightChatHistoryEvents,
    rightChatPanels,
    pendingChatUserMessages,
    runtimeIndexes,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
    contextCompaction,
  ]);
  const submitRightChatPrompt = useCallback(
    async (
      panelId: string,
      attachments: ChatAttachment[] = [],
      action: SandboxActionCatalogEntry | null = null,
      command: ComposerSlashCommand | null = null,
      options: ComposerSubmitOptions = {},
    ) => {
      const panel = rightChatPanels.find((candidate) => candidate.id === panelId);
      if (!panel) return false;
      const panelPromptForSubmit = options.promptOverride ?? panel.prompt;
      if (command?.id === "insights") {
        setLabsTab("signals");
        setView("labs");
        if (!options.preservePrompt) updateRightChatPrompt(panelId, "");
        const payload = await insights.runScan();
        const activeCount = payload?.summary?.activeCount ?? insights.summary?.activeCount ?? 0;
        showToast(`${activeCount} active insight${activeCount === 1 ? "" : "s"}.`, "info");
        return true;
      }
      if (command && !panelPromptForSubmit.trim()) {
        showToast(`Add instructions after ${command.command}.`, "info");
        return false;
      }
      if (command && attachments.length > 0) {
        showToast(
          `${command.command} tasks do not accept attachments yet. Add file context in the task thread.`,
          "error",
        );
        return false;
      }
      if (command?.id === "submit-issue" && !hasGitHubIssueSubmitConnection(connectedAppMentions)) {
        showToast("Connect the GitHub app before using /submit-issue.", "error");
        return false;
      }
      const session = panel.sessionId
        ? (sidebarSessions.find((candidate) => candidate.id === panel.sessionId) ?? null)
        : null;
      const panelOpenPondCommandAccessMode =
        session?.provider === "codex"
          ? openPondCommandAccessMode
          : (session?.openPondCommandAccessMode ?? openPondCommandAccessMode);
      const promptForTurn = command
        ? promptForRightChatCommand(command, panelPromptForSubmit)
        : panelPromptForSubmit;
      const sessionEvents = isCodexHistorySessionId(panel.sessionId)
        ? ((panel.sessionId ? rightChatHistoryEvents[panel.sessionId] : undefined) ??
          (panel.sessionId === selectedSessionId ? codexHistoryEvents : EMPTY_RUNTIME_EVENTS))
        : runtimeEventsForSession(runtimeIndexes, panel.sessionId);
      const appendRightCodexHistoryEvent =
        isCodexHistorySessionId(panel.sessionId) && panel.sessionId
          ? (event: RuntimeEvent) => {
              const historySessionId = panel.sessionId!;
              setRightChatHistoryEvents((current) => ({
                ...current,
                [historySessionId]: mergeRuntimeEventLists(
                  current[historySessionId] ?? sessionEvents,
                  [event],
                ),
              }));
            }
          : undefined;
      return sendPrompt(attachments, action, promptForTurn, {
        session,
        selectSession: false,
        provider: panel.provider,
        model: panel.model,
        openPondCommandAccessMode: panelOpenPondCommandAccessMode,
        chatMessages: buildCachedChatMessages(sessionEvents),
        displayPrompt: options.displayPrompt,
        usageAttribution:
          command?.id === "submit-issue"
            ? {
                surface: "chat",
                workflowKind: "slash_command",
                commandName: command.command,
                commandSource: "composer_selection",
              }
            : undefined,
        onCodexHistoryOptimisticEvent: appendRightCodexHistoryEvent,
        clearPrompt: options.preservePrompt
          ? () => undefined
          : () => updateRightChatPrompt(panelId, ""),
        onSessionCreated: (createdSession) => {
          setRightChatPanels((current) =>
            current.map((candidate) =>
              candidate.id === panelId
                ? {
                    ...candidate,
                    sessionId: createdSession.id,
                    provider: createdSession.provider,
                    model: createdSession.modelRef?.modelId ?? candidate.model,
                  }
                : candidate,
            ),
          );
        },
      });
    },
    [
      codexHistoryEvents,
      connectedAppMentions,
      rightChatHistoryEvents,
      rightChatPanels,
      runtimeIndexes,
      selectedSessionId,
      insights.runScan,
      insights.summary?.activeCount,
      openPondCommandAccessMode,
      sendPrompt,
      setRightChatPanels,
      setLabsTab,
      setView,
      sidebarSessions,
      showToast,
      updateRightChatPrompt,
    ],
  );

  return {
    closeRightChatPanel,
    openRightChatPanel,
    rightChatPanelViews,
    showRightChatPanel,
    showRightPanelDiffTab,
    submitRightChatPrompt,
    updateRightChatModel,
    updateRightChatPrompt,
    updateRightChatProvider,
  };
}
