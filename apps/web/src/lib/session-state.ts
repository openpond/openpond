import type { Session } from "@openpond/contracts";

export const RECENT_LOCAL_SESSION_SIDEBAR_STATE_TTL_MS = 60_000;

export type SessionSidebarStateChangeTimes = Record<string, number>;

export function mergeSessionPreservingLocalSidebarState(
  current: Session | null | undefined,
  incoming: Session,
): Session {
  if (!current || !isNewerIso(current.updatedAt, incoming.updatedAt)) return incoming;
  return {
    ...incoming,
    pinned: current.pinned,
    archived: current.archived,
    order: current.order,
    status: current.status,
    updatedAt: current.updatedAt,
  };
}

export function mergeSessionPreservingLocalSidebarStateAndRecency(
  current: Session | null | undefined,
  incoming: Session,
): Session {
  const merged = mergeSessionPreservingLocalSidebarState(current, incoming);
  return current
    ? {
        ...merged,
        pinned: current.pinned,
        archived: current.archived,
        order: current.order,
        updatedAt: current.updatedAt,
      }
    : merged;
}

export function upsertSessionPreservingLocalSidebarState(
  sessions: Session[],
  incoming: Session,
): Session[] {
  let found = false;
  const next = sessions.map((session) => {
    if (session.id !== incoming.id) return session;
    found = true;
    return mergeSessionPreservingLocalSidebarState(session, incoming);
  });
  return found ? next : [incoming, ...sessions];
}

export function upsertSessionPreservingLocalSidebarStateAndRecency(
  sessions: Session[],
  incoming: Session,
): Session[] {
  let found = false;
  const next = sessions.map((session) => {
    if (session.id !== incoming.id) return session;
    found = true;
    return mergeSessionPreservingLocalSidebarStateAndRecency(session, incoming);
  });
  return found ? next : [incoming, ...sessions];
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
