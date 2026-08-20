import { useMemo } from "react";
import type {
  AppPreferences,
  Approval,
  RuntimeEvent,
  Session,
} from "@openpond/contracts";
import { localPathWorkspaceId } from "@openpond/contracts";
import type { RightChatPanel } from "../app/app-state";
import type { RightChatPanelView } from "../components/app-shell/right-chat-panel-types";
import { buildCachedChatMessages } from "../lib/chat-messages";
import { contextWindowStatusFromUsage } from "../lib/context-window";
import {
  createImproveConversationTitle,
  latestCreateImproveRunProjection,
} from "../lib/create-pipeline-runtime";
import {
  buildRuntimeIndexes,
  latestContextUsageForSession,
  latestGoalRuntimeForSession,
} from "../lib/runtime-indexes";
import {
  appendPendingUserChatMessage,
  type PendingChatUserMessage,
} from "../lib/pending-chat-messages";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { isCloudWorkspaceKind } from "../lib/workspace-location";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];

export function useRightChatPanelViews(input: {
  approvals: Approval[];
  codexHistoryEvents: RuntimeEvent[];
  contextCompaction: AppPreferences["contextCompaction"];
  pendingChatUserMessages: Record<string, PendingChatUserMessage>;
  rightChatHistoryEvents: Record<string, RuntimeEvent[]>;
  rightChatPanels: RightChatPanel[];
  runningSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  sidebarSessions: Session[];
}): RightChatPanelView[] {
  const {
    approvals,
    codexHistoryEvents,
    contextCompaction,
    pendingChatUserMessages,
    rightChatHistoryEvents,
    rightChatPanels,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
  } = input;

  return useMemo(() => {
    const sessionById = new Map(
      sidebarSessions.map((session) => [session.id, session]),
    );
    const pendingApprovalBySessionId = latestPendingApprovals(approvals);
    return rightChatPanels.map((panel) => {
      const session = panel.sessionId
        ? sessionById.get(panel.sessionId) ?? null
        : null;
      const isHistoryPanel = isCodexHistorySessionId(panel.sessionId);
      const panelEvents = isHistoryPanel
        ? (panel.sessionId
            ? rightChatHistoryEvents[panel.sessionId]
            : undefined) ??
          (panel.sessionId === selectedSessionId
            ? codexHistoryEvents
            : EMPTY_RUNTIME_EVENTS)
        : EMPTY_RUNTIME_EVENTS;
      const panelIndexes = buildRuntimeIndexes(panelEvents, []);
      const pendingApproval = panel.sessionId
        ? pendingApprovalBySessionId.get(panel.sessionId) ?? null
        : null;
      const running = Boolean(session && runningSessionIds.has(session.id));
      const createImproveRun = isHistoryPanel
        ? latestCreateImproveRunProjection({ events: panelEvents })
        : null;
      const workspaceRootPath = session?.cwd ?? null;
      const activeWorkspaceAppId =
        session?.appId ??
        session?.localProjectId ??
        (session?.workspaceKind === "local_project"
          ? session.workspaceId ?? null
          : null) ??
        (session?.cwd && !isCloudWorkspaceKind(session.workspaceKind)
          ? localPathWorkspaceId(session.cwd)
          : null);
      const pendingUserMessage = panel.sessionId
        ? pendingChatUserMessages[panel.sessionId] ?? null
        : null;

      return {
        ...panel,
        session,
        title: createImproveConversationTitle(
          createImproveRun,
          session?.title ?? "New task",
        ),
        messages: isHistoryPanel
          ? appendPendingUserChatMessage(
              buildCachedChatMessages(panelEvents),
              pendingUserMessage,
            )
          : [],
        createImproveRun,
        contextWindowStatus: contextWindowStatusFromUsage({
          provider: panel.provider,
          snapshot: latestContextUsageForSession(panelIndexes, panel.sessionId),
          preferences: contextCompaction,
        }),
        goalRuntime: latestGoalRuntimeForSession(panelIndexes, panel.sessionId),
        pendingApproval,
        running,
        workspaceRootPath,
        activeWorkspaceAppId,
        pendingUserMessage,
        runtimeSource: isHistoryPanel ? "history" : "live",
      };
    });
  }, [
    approvals,
    codexHistoryEvents,
    contextCompaction,
    pendingChatUserMessages,
    rightChatHistoryEvents,
    rightChatPanels,
    runningSessionIds,
    selectedSessionId,
    sidebarSessions,
  ]);
}

function latestPendingApprovals(approvals: readonly Approval[]): Map<string, Approval> {
  const pendingBySessionId = new Map<string, Approval>();
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    const current = pendingBySessionId.get(approval.sessionId);
    if (!current || Date.parse(approval.createdAt) > Date.parse(current.createdAt)) {
      pendingBySessionId.set(approval.sessionId, approval);
    }
  }
  return pendingBySessionId;
}
