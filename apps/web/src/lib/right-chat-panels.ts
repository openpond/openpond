import type { Session } from "@openpond/contracts";
import type { RightChatPanel } from "../app/app-state";

export function createRightChatPanel(input: {
  sessionId: string | null;
  provider: RightChatPanel["provider"];
  model: string;
  prompt?: string;
}): RightChatPanel {
  return {
    id: `right-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    prompt: input.prompt ?? "",
    provider: input.provider,
    model: input.model,
  };
}

export function isSubagentChildSession(session: Session): session is Session & {
  parentSessionId: string;
  subagentRunId: string;
} {
  return Boolean(session.parentSessionId && session.subagentRunId);
}

export function newlyObservedSubagentSessions(input: {
  sessions: readonly Session[];
  knownSessionIds: ReadonlySet<string>;
}): {
  knownSessionIds: Set<string>;
  newSessions: Session[];
} {
  const childSessions = input.sessions.filter(isSubagentChildSession);
  return {
    knownSessionIds: new Set(childSessions.map((session) => session.id)),
    newSessions: childSessions.filter((session) => !input.knownSessionIds.has(session.id)),
  };
}

export function appendSubagentRightChatPanels(
  panels: RightChatPanel[],
  sessions: readonly Session[],
): RightChatPanel[] {
  const existingSessionIds = new Set(panels.map((panel) => panel.sessionId).filter(Boolean));
  const additions = sessions
    .filter(isSubagentChildSession)
    .filter((session) => !existingSessionIds.has(session.id))
    .map((session) => ({
      id: `right-subagent-${session.id}`,
      sessionId: session.id,
      prompt: "",
      provider: session.provider,
      model: session.modelRef?.modelId ?? "",
    }));
  return additions.length > 0 ? [...panels, ...additions] : panels;
}
