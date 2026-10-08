import { createHash, randomUUID } from "node:crypto";
import {
  CreateSessionRequestSchema,
  DEFAULT_SESSION_EXPERIENCE,
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  OpenPondCommandAccessModeSchema,
  PatchSessionRequestSchema,
  type AppPreferences,
  type PatchSessionRequest,
  type RuntimeEvent,
  type Session,
  type Turn,
  type PonderDesktopOperation,
  ponderDesktopRequestContent,
} from "@openpond/contracts";
import type { SqliteStore } from "./store.js";
import { ponderDesktopSessionRevision, ponderDesktopExecutionRevision } from "../openpond/ponder-desktop-catalog.js";
import { event, now } from "../utils.js";
import { publicSessionMetadata, preservePonderSessionIdentity, PonderLocalOwnerSchema,
  type PonderLocalOwner } from "../openpond/ponder-local-scope.js";

export type ReservedSessionCreation = {
  sessionId: string;
  operationId: string;
  payloadHash: string;
  owner?: PonderLocalOwner;
  desktopOperation?: PonderDesktopOperation;
  remoteStarterSourceSessionId?: string;
};

export function createSessionStore(deps: {
  store: Pick<SqliteStore,
    "sessionCount" | "insertSessionAtFront" | "getSession" | "updateSession" | "getTurn" | "insertTurn" | "updateTurn">;
  defaultSessionCwd: (appId?: string | null) => string;
  createManagedLocalWorkCwd?: (sessionId: string) => Promise<string>;
  loadAppPreferences?: () => Promise<AppPreferences>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  loadLastUsedProfile?: () => Promise<Session["currentProfile"]>;
  captureUserOwner?: (payload: unknown) => Promise<PonderLocalOwner | null>;
}) {
  const {
    store,
    defaultSessionCwd,
    createManagedLocalWorkCwd,
    loadAppPreferences,
    appendRuntimeEvent,
    loadLastUsedProfile,
  } = deps;

  async function createSession(payload: unknown): Promise<Session> {
    return createSessionInternal(payload);
  }

  async function createUserSession(payload: unknown): Promise<Session> {
    const input = CreateSessionRequestSchema.parse(payload);
    return createSessionInternal(input, undefined, await deps.captureUserOwner?.(input) ?? null);
  }

  /** Only in-process dispatch owners may reserve identities; HTTP payloads cannot choose them. */
  async function createReservedSession(payload: unknown, reservation: ReservedSessionCreation): Promise<Session> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(reservation.sessionId)
      || !reservation.operationId || !/^[a-f0-9]{64}$/.test(reservation.payloadHash)) {
      throw new Error("reserved_session_identity_invalid");
    }
    return createSessionInternal(payload, reservation, reservation.owner ?? null);
  }

  async function recoverReservedSession(reservation: ReservedSessionCreation, creationHash: string): Promise<Session | null> {
    const session = await store.getSession(reservation.sessionId);
    if (!session) return null;
    const identity = session.metadata?.ponderDesktopReservation;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)
      || (identity as Record<string, unknown>).operationId !== reservation.operationId
      || (identity as Record<string, unknown>).payloadHash !== reservation.payloadHash
      || (identity as Record<string, unknown>).creationHash !== creationHash) {
      throw new Error("reserved_session_identity_mismatch");
    }
    return normalizeSession(session);
  }

  async function createSessionInternal(payload: unknown, reservation?: ReservedSessionCreation, owner: PonderLocalOwner | null = null): Promise<Session> {
    const input = CreateSessionRequestSchema.parse(payload);
    const metadata = publicSessionMetadata(input.metadata);
    const workspaceRevision = input.metadata?.ponderWorkspaceRevision;
    if (reservation && workspaceRevision !== undefined) {
      if (typeof workspaceRevision !== "string" || !/^[a-f0-9]{64}$/.test(workspaceRevision))
        throw new Error("ponder_desktop_workspace_revision_invalid");
      metadata.ponderWorkspaceRevision = workspaceRevision;
    }
    if (owner) metadata.ponderLocalOwner = PonderLocalOwnerSchema.parse(owner);
    if (reservation?.remoteStarterSourceSessionId) metadata.remoteStarterSourceSessionId = reservation.remoteStarterSourceSessionId;
    const creationHash = reservation ? createHash("sha256").update(ponderDesktopRequestContent("POST", "/local/session",
      JSON.parse(JSON.stringify({ ...input, metadata })))).digest("hex") : "";
    if (reservation) {
      const existing = await recoverReservedSession(reservation, creationHash);
      if (existing) return existing;
    }
    const createdAt = now();
    const sessionId = reservation?.sessionId ?? randomUUID();
    const sessionCount = await store.sessionCount();
    const workspaceKind =
      input.workspaceKind ?? (input.appId ? "sandbox_app" : undefined);
    const openPondCommandAccessMode =
      input.openPondCommandAccessMode ??
      (loadAppPreferences
        ? (await loadAppPreferences()).openPondCommandAccessMode
        : DEFAULT_OPENPOND_COMMAND_ACCESS_MODE);
    const currentProfile =
      input.currentProfile !== undefined
        ? input.currentProfile
        : loadLastUsedProfile
        ? await loadLastUsedProfile()
        : null;
    if (input.profileWorkflowBinding &&
        input.currentProfile?.profileId !== input.profileWorkflowBinding.profileId) {
      throw new Error("Profile workflow session requires its selected Profile reference.");
    }
    if (input.profileComponentBinding && (
      input.profileWorkflowBinding
      || input.currentProfile?.profileId !== input.profileComponentBinding.profileId
    )) {
      throw new Error("Profile component session requires its selected Profile reference and a single binding.");
    }
    const managedLocalWork =
      input.experience === "work" &&
      !workspaceKind &&
      !input.appId &&
      !input.localProjectId &&
      !input.cloudProjectId &&
      input.metadata?.workspaceTarget === "local";
    const cwd = managedLocalWork
      ? createManagedLocalWorkCwd
        ? await createManagedLocalWorkCwd(sessionId)
        : defaultSessionCwd(null)
      : input.cwd === undefined
        ? defaultSessionCwd(input.appId)
        : input.cwd;
    const session: Session = {
      id: sessionId,
      experience: input.experience ?? DEFAULT_SESSION_EXPERIENCE,
      provider: input.provider,
      modelRef: input.modelRef ?? null,
      openPondCommandAccessMode,
      systemKind: input.systemKind ?? null,
      hiddenFromDefaultSidebar: input.hiddenFromDefaultSidebar ?? false,
      parentSessionId: input.parentSessionId ?? null,
      parentTurnId: input.parentTurnId ?? null,
      subagentRunId: input.subagentRunId ?? null,
      subagentRoleId: input.subagentRoleId ?? null,
      subagentDelegationMode: input.subagentDelegationMode ?? null,
      title:
        input.title !== undefined
          ? input.title
          : input.appName || "New chat",
      appId: input.appId ?? null,
      appName: input.appName ?? null,
      workspaceKind,
      workspaceId: input.workspaceId ?? input.appId ?? null,
      workspaceName: input.workspaceName ?? input.appName ?? null,
      localProjectId: input.localProjectId ?? null,
      cloudProjectId: input.cloudProjectId ?? null,
      cloudTeamId: input.cloudTeamId ?? null,
      currentProfile,
      profileWorkflowBinding: input.profileWorkflowBinding ?? null,
      profileComponentBinding: input.profileComponentBinding ?? null,
      ...(Object.keys(metadata).length || reservation ? { metadata: {
        ...metadata,
        ...(reservation ? { ponderDesktopReservation: {
          operationId: reservation.operationId, payloadHash: reservation.payloadHash, creationHash,
        } } : {}),
      } } : {}),
      cwd,
      codexThreadId: null,
      createdAt,
      updatedAt: createdAt,
      status: "idle",
      runtimeSeconds: 0,
      runtimeRunningSince: null,
      pinned: false,
      savedForLater: false,
      archived: false,
      order: sessionCount,
    };
    if (reservation) {
      const identity = session.metadata!.ponderDesktopReservation as Record<string, unknown>;
      identity.sessionRevision = ponderDesktopSessionRevision(session, null);
      identity.executionRevision = ponderDesktopExecutionRevision(session);
    }
    try {
      await store.insertSessionAtFront(session, reservation?.desktopOperation);
    } catch (error) {
      // SQLite's unique session key arbitrates concurrent owners. A lost local
      // acknowledgement recovers this session instead of starting another one.
      if (reservation) {
        const existing = await recoverReservedSession(reservation, creationHash);
        if (existing) return existing;
      }
      throw error;
    }
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        name: "session.started",
        source: "server",
        appId: session.appId,
        data: {
          provider: session.provider,
          appName: session.appName,
          cwd: session.cwd,
          session,
        },
      })
    );
    return session;
  }

  async function patchSession(
    sessionId: string,
    payload: unknown
  ): Promise<Session> {
    const input = PatchSessionRequestSchema.parse(payload);
    const updated = await store.updateSession(sessionId, (session) =>
      normalizeSession(
        {
          ...session,
          ...input,
          ...(input.metadata !== undefined ? { metadata: preservePonderSessionIdentity(session.metadata, input.metadata) } : {}),
          ...(input.title !== undefined ? { metadata: { ...session.metadata, ...preservePonderSessionIdentity(session.metadata, input.metadata), titleSource: "manual", autoTitle: null } } : {}),
          updatedAt: session.updatedAt,
        },
        input
      )
    );
    if (!updated) throw new Error("Session not found");
    await appendRuntimeEvent(event({
      sessionId,
      name: "session.updated",
      source: "server",
      data: { session: updated },
    }));
    return updated;
  }

  async function getSession(sessionId: string): Promise<Session> {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return normalizeSession(session);
  }

  async function updateSession(
    sessionId: string,
    patch: Partial<Session>
  ): Promise<Session> {
    const updated = await store.updateSession(sessionId, (session) =>
      normalizeSession({
        ...session,
        ...patch,
        ...(patch.metadata !== undefined ? { metadata: preservePonderSessionIdentity(session.metadata, patch.metadata) } : {}),
        updatedAt: now(),
      })
    );
    if (!updated) throw new Error("Session not found");
    return updated;
  }

  async function completeTurn(
    sessionId: string,
    turnId: string,
    providerTurnId?: string | null
  ): Promise<Turn> {
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

  async function failTurn(
    session: Session,
    turnId: string,
    message: string
  ): Promise<Turn> {
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

  async function interruptTurn(
    session: Session,
    turnId: string,
    message = "Stopped by user"
  ): Promise<Turn> {
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
    createUserSession,
    createReservedSession,
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
  sidebarPatch?: Pick<
    PatchSessionRequest,
    "archived" | "pinned" | "savedForLater"
  >
): Session {
  const parsed = OpenPondCommandAccessModeSchema.safeParse(
    (session as Session & { openPondCommandAccessMode?: unknown })
      .openPondCommandAccessMode
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
    experience: session.experience ?? DEFAULT_SESSION_EXPERIENCE,
    openPondCommandAccessMode: parsed.success
      ? parsed.data
      : DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
    currentProfile: session.currentProfile ?? null,
    pinned,
    savedForLater,
    archived,
  };
}
