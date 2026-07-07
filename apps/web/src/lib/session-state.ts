import type { Session } from "@openpond/contracts";

export const RECENT_LOCAL_SESSION_SIDEBAR_STATE_TTL_MS = 60_000;

export type SessionSidebarStateChangeTimes = Record<string, number>;

export function mergeSessionPreservingLocalSidebarState(
  current: Session | null | undefined,
  incoming: Session,
): Session {
  if (!current) return incoming;
  const merged = isNewerIso(current.updatedAt, incoming.updatedAt) ? {
    ...incoming,
    pinned: current.pinned,
    archived: current.archived,
    order: current.order,
    status: current.status,
    updatedAt: current.updatedAt,
  } : incoming;
  return sameSession(current, merged) ? current : merged;
}

export function mergeSessionPreservingLocalSidebarStateAndRecency(
  current: Session | null | undefined,
  incoming: Session,
): Session {
  const merged = mergeSessionPreservingLocalSidebarState(current, incoming);
  const next = current
    ? {
        ...merged,
        pinned: current.pinned,
        archived: current.archived,
        order: current.order,
        updatedAt: current.updatedAt,
      }
    : merged;
  return current && sameSession(current, next) ? current : next;
}

export function upsertSessionPreservingLocalSidebarState(
  sessions: Session[],
  incoming: Session,
): Session[] {
  let found = false;
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== incoming.id) return session;
    found = true;
    const merged = mergeSessionPreservingLocalSidebarState(session, incoming);
    if (merged !== session) changed = true;
    return merged;
  });
  return found ? (changed ? next : sessions) : [incoming, ...sessions];
}

export function upsertSessionPreservingLocalSidebarStateAndRecency(
  sessions: Session[],
  incoming: Session,
): Session[] {
  let found = false;
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== incoming.id) return session;
    found = true;
    const merged = mergeSessionPreservingLocalSidebarStateAndRecency(session, incoming);
    if (merged !== session) changed = true;
    return merged;
  });
  return found ? (changed ? next : sessions) : [incoming, ...sessions];
}

export function mergeSessionListPreservingLocalSidebarState(
  current: Session[],
  incoming: Session[],
  recentLocalSidebarChangeTimes?: SessionSidebarStateChangeTimes,
  now = Date.now(),
): Session[] {
  const currentById = new Map(current.map((session) => [session.id, session]));
  return incoming.map((session) => {
    const currentSession = currentById.get(session.id);
    if (currentSession && recentLocalSidebarChangeTimes) {
      const recentLocal = mergeRecentLocalSessionSidebarState(
        currentSession,
        session,
        recentLocalSidebarChangeTimes,
        now,
      );
      if (recentLocal) return recentLocal;
    }
    return mergeSessionPreservingLocalSidebarState(currentSession, session);
  });
}

export function mergeBootstrapSessionListPreservingLocalState(
  current: Session[],
  incoming: Session[],
  recentLocalSidebarChangeTimes?: SessionSidebarStateChangeTimes,
  now = Date.now(),
): Session[] {
  const currentById = new Map(current.map((session) => [session.id, session]));
  const mergedIncomingById = new Map(
    mergeSessionListPreservingLocalSidebarState(
      current,
      incoming,
      recentLocalSidebarChangeTimes,
      now,
    ).map((session) => [session.id, session]),
  );
  const currentIds = new Set(currentById.keys());
  const newIncomingSessions = incoming
    .filter((session) => !currentIds.has(session.id))
    .map((session) => mergedIncomingById.get(session.id) ?? session);
  const existingAndPreservedSessions = current
    .map((session) => {
      const mergedIncoming = mergedIncomingById.get(session.id);
      if (mergedIncoming) return mergedIncoming;
      return shouldPreserveMissingBootstrapSession(session, incoming) ? session : null;
    })
    .filter((session): session is Session => Boolean(session));
  return [...newIncomingSessions, ...existingAndPreservedSessions];
}

export function shouldPreserveMissingBootstrapSession(session: Session, incoming: Session[]): boolean {
  const sessionUpdatedAt = Date.parse(session.updatedAt);
  if (!Number.isFinite(sessionUpdatedAt)) return false;
  const newestIncomingUpdatedAt = latestSessionUpdatedAt(incoming);
  return newestIncomingUpdatedAt === null || sessionUpdatedAt >= newestIncomingUpdatedAt;
}

export function recordSessionSidebarStateChanges(
  changeTimes: SessionSidebarStateChangeTimes,
  previous: Session[],
  next: Session[],
  changedAt = Date.now(),
): void {
  const previousById = new Map(previous.map((session) => [session.id, session]));
  for (const nextSession of next) {
    const previousSession = previousById.get(nextSession.id);
    if (!previousSession) continue;
    if (!sameSessionSidebarState(previousSession, nextSession)) {
      changeTimes[nextSession.id] = changedAt;
    }
  }
}

function isNewerIso(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs;
}

function sameSession(left: Session, right: Session): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function latestSessionUpdatedAt(sessions: Session[]): number | null {
  let latest: number | null = null;
  for (const session of sessions) {
    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    latest = latest === null ? updatedAt : Math.max(latest, updatedAt);
  }
  return latest;
}

function mergeRecentLocalSessionSidebarState(
  current: Session,
  incoming: Session,
  changeTimes: SessionSidebarStateChangeTimes,
  now: number,
): Session | null {
  const changedAt = changeTimes[incoming.id];
  if (changedAt === undefined) return null;
  if (now - changedAt > RECENT_LOCAL_SESSION_SIDEBAR_STATE_TTL_MS) {
    delete changeTimes[incoming.id];
    return null;
  }
  if (sameSessionSidebarState(current, incoming)) {
    delete changeTimes[incoming.id];
    return null;
  }
  return {
    ...incoming,
    pinned: current.pinned,
    archived: current.archived,
    order: current.order,
  };
}

function sameSessionSidebarState(left: Session, right: Session): boolean {
  return (
    left.pinned === right.pinned &&
    left.archived === right.archived &&
    left.order === right.order
  );
}
