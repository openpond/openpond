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
    activationVersion: 1,
    sessionId: input.sessionId,
    prompt: input.prompt ?? "",
    provider: input.provider,
    model: input.model,
    scrollTop: 0,
    stickyToBottom: true,
  };
}

export function mostRecentlyActivatedRightChatPanel<T extends RightChatPanel>(
  panels: readonly T[],
): T | null {
  return panels.reduce<T | null>((latest, panel) => {
    if (!latest || panel.activationVersion >= latest.activationVersion) return panel;
    return latest;
  }, null);
}

export function activateRightChatPanel(
  panels: readonly RightChatPanel[],
  panelId: string,
): RightChatPanel[] {
  const nextActivationVersion = Math.max(0, ...panels.map((panel) => panel.activationVersion)) + 1;
  let activated = false;
  const nextPanels = panels.map((panel) => {
    if (panel.id !== panelId) return panel;
    activated = true;
    return { ...panel, activationVersion: nextActivationVersion };
  });
  return activated ? nextPanels : [...panels];
}

export function activateRightChatSessionPanel(
  panels: readonly RightChatPanel[],
  input: { sessionId: string; prompt?: string },
): RightChatPanel[] {
  const nextActivationVersion = Math.max(0, ...panels.map((panel) => panel.activationVersion)) + 1;
  let activated = false;
  const nextPanels = panels.map((panel) => {
    if (panel.sessionId !== input.sessionId) return panel;
    activated = true;
    return {
      ...panel,
      activationVersion: nextActivationVersion,
      prompt: input.prompt ?? panel.prompt,
    };
  });
  return activated ? nextPanels : [...panels];
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
      activationVersion: 1,
      sessionId: session.id,
      prompt: "",
      provider: session.provider,
      model: session.modelRef?.modelId ?? "",
      scrollTop: 0,
      stickyToBottom: true,
    }));
  return additions.length > 0 ? [...panels, ...additions] : panels;
}
