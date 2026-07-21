import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type {
  AppPreferences,
  ChatAttachment,
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
import type { AppView } from "../lib/app-models";
import { normalizeChatModel } from "../lib/app-models";
import type { PendingChatUserMessage } from "../lib/pending-chat-messages";
import {
  activateRightChatSessionPanel,
  activateRightChatPanel,
  appendSubagentRightChatPanels,
  createRightChatPanel,
  newlyObservedSubagentSessions,
} from "../lib/right-chat-panels";
import { loadCodexHistoryThreadPayload } from "../lib/codex-history-thread-cache";
import { buildRuntimeIndexes, runtimeEventsForSession } from "../lib/runtime-indexes";
import { buildCachedChatMessages } from "../lib/chat-messages";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { hasGitHubIssueSubmitConnection } from "../lib/submit-issue-command";
import type { SandboxActionCatalogEntry } from "../lib/sandbox-types";
import type { ConnectedAppMentionOption } from "../lib/connected-app-mentions";
import { mergeRuntimeEventLists } from "../lib/runtime-event-lists";
import { rightChatCommandPolicy } from "../lib/right-chat-command-policy";
import type { useChatActions } from "./useChatActions";
import { useRightChatPanelViews } from "./useRightChatPanelViews";
import { useRightChatHistorySubscriptions } from "./useRightChatHistorySubscriptions";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

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
  openLabSuggestions: () => void;
  openLabTraining: (input: { objective: string | null; sessionId: string | null }) => void;
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
  setError: Dispatch<SetStateAction<string | null>>;
  setRightChatHistoryEvents: Dispatch<SetStateAction<Record<string, RuntimeEvent[]>>>;
  setRightChatPanels: Dispatch<SetStateAction<RightChatPanel[]>>;
  setRightPanelMode: Dispatch<SetStateAction<RightPanelMode>>;
  setRightPanelTabRequest: Dispatch<SetStateAction<WorkspaceDiffTabRequest | null>>;
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
    openLabSuggestions,
    openLabTraining,
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
    setError,
    setRightChatHistoryEvents,
    setRightChatPanels,
    setRightPanelMode,
    setRightPanelTabRequest,
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
    (
      session: Session | null = null,
      options: { preserveView?: boolean; prompt?: string } = {},
    ) => {
      const existingPanel = session?.id
        ? rightChatPanels.find((panel) => panel.sessionId === session.id) ?? null
        : null;
      if (existingPanel) {
        setRightChatPanels((current) => activateRightChatSessionPanel(current, {
          sessionId: session!.id,
          prompt: options.prompt,
        }));
        setDiffPanelOpen(true);
        setRightPanelMode("chat");
        if (!options.preserveView) setView("chat");
        return existingPanel.id;
      }
      const nextPanel = createRightChatPanel({
        sessionId: session?.id ?? null,
        provider: session?.provider ?? activeProvider,
        model: session?.modelRef?.modelId ?? activeModel,
        prompt: options.prompt,
      });
      setRightChatPanels((current) => [...current, nextPanel]);
      setDiffPanelOpen(true);
      setRightPanelMode("chat");
      if (!options.preserveView) setView("chat");
      return nextPanel.id;
    },
    [activeModel, activeProvider, rightChatPanels, setDiffPanelOpen, setRightChatPanels, setRightPanelMode, setView],
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
  const activateRightChatPanelById = useCallback(
    (panelId: string) => {
      setRightChatPanels((current) => activateRightChatPanel(current, panelId));
    },
    [setRightChatPanels],
  );
  const updateRightChatScrollState = useCallback(
    (panelId: string, state: { scrollTop: number; stickyToBottom: boolean }) => {
      setRightChatPanels((current) => current.map((panel) =>
        panel.id === panelId ? { ...panel, ...state } : panel));
    },
    [setRightChatPanels],
  );
  const updateRightChatModel = useCallback(
    (panelId: string, model: string) => {
      setRightChatPanels((current) =>
        current.map((panel) => (panel.id === panelId ? { ...panel, model } : panel)),
      );
    },
    [setRightChatPanels],
  );
  const updateRightChatProvider = useCallback(
    (panelId: string, provider: RightChatPanel["provider"]) => {
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
    [providerSettings, setRightChatPanels],
  );
  useRightChatHistorySubscriptions({
    applyPayload: applyRightCodexHistoryPayload,
    connection,
    locallyActiveSessionIds: locallyActiveCodexHistorySessionIds,
    panels: rightChatPanels,
    sessions: sidebarSessions,
    setError,
  });

  const rightChatPanelViews = useRightChatPanelViews({
    codexHistoryEvents,
    contextCompaction,
    pendingChatUserMessages,
    rightChatHistoryEvents,
    rightChatPanels,
    runtimeIndexes,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
  });
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
      const commandPolicy = command
        ? rightChatCommandPolicy(command, panelPromptForSubmit)
        : null;
      if (commandPolicy?.kind === "open_insights") {
        openLabSuggestions();
        if (!options.preservePrompt) updateRightChatPrompt(panelId, "");
        const payload = await insights.runScan();
        const activeCount = payload?.summary?.activeCount ?? insights.summary?.activeCount ?? 0;
        showToast(`${activeCount} active insight${activeCount === 1 ? "" : "s"}.`, "info");
        return true;
      }
      if (commandPolicy?.kind === "open_training") {
        if (attachments.length > 0) {
          showToast("/train uses this chat; add other chats from Lab.", "error");
          return false;
        }
        openLabTraining({
          objective: commandPolicy.objective,
          sessionId: panel.sessionId,
        });
        if (!options.preservePrompt) updateRightChatPrompt(panelId, "");
        return true;
      }
      if (
        command
        && commandPolicy?.kind === "send_prompt"
        && commandPolicy.requiresInstructions
        && !panelPromptForSubmit.trim()
      ) {
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
        panel.provider === "codex"
          ? openPondCommandAccessMode
          : (session?.openPondCommandAccessMode ?? openPondCommandAccessMode);
      const promptForTurn = commandPolicy?.kind === "send_prompt"
        ? commandPolicy.prompt
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
      openLabSuggestions,
      openLabTraining,
      openPondCommandAccessMode,
      sendPrompt,
      setRightChatPanels,
      setView,
      sidebarSessions,
      showToast,
      updateRightChatPrompt,
    ],
  );

  return {
    activateRightChatPanel: activateRightChatPanelById,
    closeRightChatPanel,
    openRightChatPanel,
    rightChatPanelViews,
    showRightChatPanel,
    showRightPanelDiffTab,
    submitRightChatPrompt,
    updateRightChatModel,
    updateRightChatPrompt,
    updateRightChatProvider,
    updateRightChatScrollState,
  };
}
