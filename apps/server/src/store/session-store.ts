import { randomUUID } from "node:crypto";
import {
  CreateSessionRequestSchema,
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  OpenPondCommandAccessModeSchema,
  PatchSessionRequestSchema,
  type AppPreferences,
  type PatchSessionRequest,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type { SqliteStore } from "./store.js";
import { event, now } from "../utils.js";

export function createSessionStore(deps: {
  store: SqliteStore;
  defaultSessionCwd: (appId?: string | null) => string;
  loadAppPreferences?: () => Promise<AppPreferences>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
}) {
  const { store, defaultSessionCwd, loadAppPreferences, appendRuntimeEvent } = deps;

  async function createSession(payload: unknown): Promise<Session> {
    const input = CreateSessionRequestSchema.parse(payload);
    const createdAt = now();
    const sessionCount = await store.sessionCount();
    const workspaceKind = input.workspaceKind ?? (input.appId ? "sandbox_app" : undefined);
    const openPondCommandAccessMode =
      input.openPondCommandAccessMode ??
      (loadAppPreferences ? (await loadAppPreferences()).openPondCommandAccessMode : DEFAULT_OPENPOND_COMMAND_ACCESS_MODE);
    const session: Session = {
      id: randomUUID(),
      provider: input.provider,
      modelRef: input.modelRef ?? null,
      openPondCommandAccessMode,
      systemKind: input.systemKind ?? null,
      hiddenFromDefaultSidebar: input.hiddenFromDefaultSidebar ?? false,
      parentSessionId: input.parentSessionId ?? null,
      parentTurnId: input.parentTurnId ?? null,
      parentGoalId: input.parentGoalId ?? null,
      subagentRunId: input.subagentRunId ?? null,
      subagentRoleId: input.subagentRoleId ?? null,
      subagentDelegationMode: input.subagentDelegationMode ?? null,
      title: input.title || input.appName || "New chat",
      appId: input.appId ?? null,
      appName: input.appName ?? null,
      workspaceKind,
      workspaceId: input.workspaceId ?? input.appId ?? null,
      workspaceName: input.workspaceName ?? input.appName ?? null,
      localProjectId: input.localProjectId ?? null,
      cloudProjectId: input.cloudProjectId ?? null,
      cloudTeamId: input.cloudTeamId ?? null,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      cwd: input.cwd === undefined ? defaultSessionCwd(input.appId) : input.cwd,
      codexThreadId: null,
      createdAt,
      updatedAt: createdAt,
      status: "idle",
      pinned: false,
      savedForLater: false,
      archived: false,
      order: sessionCount,
    };
    await store.insertSessionAtFront(session);
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        name: "session.started",
        source: "server",
        appId: session.appId,
        data: { provider: session.provider, appName: session.appName, cwd: session.cwd },
      })
    );
    return session;
  }

  async function patchSession(sessionId: string, payload: unknown): Promise<Session> {
    const input = PatchSessionRequestSchema.parse(payload);
    const updated = await store.updateSession(sessionId, (session) =>
      normalizeSession(
        {
          ...session,
          ...input,
          updatedAt: session.updatedAt,
        },
        input,
      ),
    );
    if (!updated) throw new Error("Session not found");
    return updated;
  }

  async function getSession(sessionId: string): Promise<Session> {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return normalizeSession(session);
  }

  async function updateSession(sessionId: string, patch: Partial<Session>): Promise<Session> {
    const updated = await store.updateSession(sessionId, (session) =>
      normalizeSession({
        ...session,
        ...patch,
        updatedAt: now(),
      }),
    );
    if (!updated) throw new Error("Session not found");
    return updated;
  }

  async function completeTurn(sessionId: string, turnId: string, providerTurnId?: string | null): Promise<Turn> {
    const completedAt = now();
    const completed = await store.updateTurn(turnId, (turn) => ({
      ...turn,
      providerTurnId: providerTurnId ?? turn.providerTurnId,
      completedAt,
      status: "completed",
    }));
    if (!completed) throw new Error("Turn not found");
    await updateSession(sessionId, { status: "idle" });
    return completed;
  }

  async function failTurn(session: Session, turnId: string, message: string): Promise<Turn> {
    const failed = await store.updateTurn(turnId, (turn) => ({
      ...turn,
      completedAt: now(),
      status: "failed",
      error: message,
    }));
    if (!failed) throw new Error("Turn not found");
    await updateSession(session.id, { status: "failed" });
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "turn.failed",
        source: "provider",
        appId: session.appId,
        status: "failed",
        error: message,
      })
    );
    return failed;
  }

  async function interruptTurn(session: Session, turnId: string, message = "Stopped by user"): Promise<Turn> {
    let changed = false;
    const interrupted = await store.updateTurn(turnId, (current) => {
      if (current.status !== "in_progress") return current;
      changed = true;
      return {
        ...current,
        completedAt: now(),
        status: "interrupted",
        error: message,
      };
    });
    if (!interrupted) throw new Error("Turn not found");
    await updateSession(session.id, { status: "idle" });
    if (changed) {
      await appendRuntimeEvent(
        event({
          sessionId: session.id,
          turnId,
          name: "turn.interrupted",
          source: "server",
          appId: session.appId,
          status: "completed",
          output: message,
        })
      );
    }
    return interrupted;
  }

  return {
    createSession,
    patchSession,
    getSession,
    updateSession,
    completeTurn,
    failTurn,
    interruptTurn,
  };
}

function normalizeSession(
  session: Session,
  sidebarPatch?: Pick<PatchSessionRequest, "archived" | "pinned" | "savedForLater">,
): Session {
  const parsed = OpenPondCommandAccessModeSchema.safeParse(
    (session as Session & { openPondCommandAccessMode?: unknown }).openPondCommandAccessMode,
  );
  let pinned = Boolean(session.pinned);
  let savedForLater = Boolean(session.savedForLater);
  let archived = Boolean(session.archived);
  if (sidebarPatch?.archived === true) {
    pinned = false;
    savedForLater = false;
    archived = true;
  } else if (sidebarPatch?.savedForLater === true) {
    pinned = false;
    savedForLater = true;
    archived = false;
  } else if (sidebarPatch?.pinned === true) {
    pinned = true;
    savedForLater = false;
    archived = false;
  } else if (archived) {
    pinned = false;
    savedForLater = false;
  } else if (savedForLater) {
    pinned = false;
  }
  return {
    ...session,
    openPondCommandAccessMode: parsed.success ? parsed.data : DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
    pinned,
    savedForLater,
    archived,
  };
}
