import { useMemo } from "react";
import type { AppPreferences, RuntimeEvent, Session } from "@openpond/contracts";
import type { RightChatPanel } from "../app/app-state";
import type { RightChatPanelView } from "../components/app-shell/right-chat-panel-types";
import { buildCachedChatMessages } from "../lib/chat-messages";
import { contextWindowStatusFromUsage } from "../lib/context-window";
import {
  createImproveConversationTitle,
  latestCreateImproveRunProjection,
} from "../lib/create-pipeline-runtime";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import {
  buildRuntimeIndexes,
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
  latestPendingApprovalForSession,
  runtimeEventsForSession,
} from "../lib/runtime-indexes";
import { appendPendingUserChatMessage, type PendingChatUserMessage } from "../lib/pending-chat-messages";
import { latestTurnCompletionState } from "../lib/turn-completion-state";
import { isCloudWorkspaceKind } from "../lib/workspace-location";
import { localPathWorkspaceId } from "@openpond/contracts";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

export function useRightChatPanelViews(input: {
  codexHistoryEvents: RuntimeEvent[];
  contextCompaction: AppPreferences["contextCompaction"];
  pendingChatUserMessages: Record<string, PendingChatUserMessage>;
  rightChatHistoryEvents: Record<string, RuntimeEvent[]>;
  rightChatPanels: RightChatPanel[];
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  runningSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  sidebarSessions: Session[];
}): RightChatPanelView[] {
  const {
    codexHistoryEvents,
    contextCompaction,
    pendingChatUserMessages,
    rightChatHistoryEvents,
    rightChatPanels,
    runtimeIndexes,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
  } = input;

  return useMemo(() => {
    const sessionById = new Map(sidebarSessions.map((session) => [session.id, session]));
    return rightChatPanels.map((panel) => {
      const session = panel.sessionId ? (sessionById.get(panel.sessionId) ?? null) : null;
      const provider = panel.provider;
      const isHistoryPanel = isCodexHistorySessionId(panel.sessionId);
      const panelEvents = isHistoryPanel
        ? ((panel.sessionId ? rightChatHistoryEvents[panel.sessionId] : undefined)
          ?? (panel.sessionId === selectedSessionId
            ? codexHistoryEvents
            : EMPTY_RUNTIME_EVENTS))
        : runtimeEventsForSession(runtimeIndexes, panel.sessionId);
      const panelIndexes = isHistoryPanel ? buildRuntimeIndexes(panelEvents, []) : runtimeIndexes;
      const panelTurnCompletionState = latestTurnCompletionState(panelEvents);
      const panelPendingApproval = latestPendingApprovalForSession(panelIndexes, panel.sessionId);
      const panelRunning = Boolean(
        session
        && (runningSessionIds.has(session.id)
          || (!session.systemKind
            && session.status === "active"
            && panelTurnCompletionState === "pending")),
      );
      const contextWindowStatus = contextWindowStatusFromUsage({
        provider,
        snapshot: latestContextUsageForSession(panelIndexes, panel.sessionId),
        preferences: contextCompaction,
      });
      const workspaceRootPath = session?.cwd ?? null;
      const activeWorkspaceAppId =
        session?.appId
        ?? session?.localProjectId
        ?? (session?.workspaceKind === "local_project" ? (session.workspaceId ?? null) : null)
        ?? (session?.cwd && !isCloudWorkspaceKind(session.workspaceKind)
          ? localPathWorkspaceId(session.cwd)
          : null);
      const panelMessages = buildCachedChatMessages(panelEvents);
      const createImproveRun = latestCreateImproveRunProjection({ events: panelEvents });

      return {
        ...panel,
        session,
        title: createImproveConversationTitle(
          createImproveRun,
          session?.title ?? "New task",
        ),
        messages: appendPendingUserChatMessage(
          panelMessages,
          panel.sessionId ? pendingChatUserMessages[panel.sessionId] : null,
        ),
        createImproveRun,
        contextWindowStatus,
        goalRuntime: latestGoalRuntimeForSession(panelIndexes, panel.sessionId),
        pendingApproval: panelPendingApproval,
        running: panelRunning,
        steerAutoDispatchBlocked:
          Boolean(panelPendingApproval) || panelTurnCompletionState === "blocked",
        steerAutoDispatchReady:
          panelTurnCompletionState === "completed" && !panelPendingApproval && !panelRunning,
        workspaceRootPath,
        activeWorkspaceAppId,
      };
    });
  }, [
    codexHistoryEvents,
    contextCompaction,
    pendingChatUserMessages,
    rightChatHistoryEvents,
    rightChatPanels,
    runningSessionIds,
    runtimeIndexes,
    selectedSessionId,
    sidebarSessions,
  ]);
}
