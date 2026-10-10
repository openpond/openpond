import type { RuntimeEvent, Session } from "@openpond/contracts";

const ACTIVITY_EVENTS = new Set([
  "turn.started", "turn.completed", "turn.failed", "turn.interrupted",
  "approval.requested", "approval.resolved", "task.input", "task.wait",
]);

/** Polling, diagnostics, renames and per-token deltas never reorder the inbox. */
export function sidebarActivityTimes(events: readonly RuntimeEvent[]): Record<string, string> {
  const times: Record<string, string> = {};
  for (const event of events) {
    if (!event.sessionId) continue;
    if (!ACTIVITY_EVENTS.has(event.name)) continue;
    if (Date.parse(event.timestamp) > Date.parse(times[event.sessionId] ?? "")) times[event.sessionId] = event.timestamp;
    else if (!times[event.sessionId] && Number.isFinite(Date.parse(event.timestamp))) times[event.sessionId] = event.timestamp;
  }
  return times;
}

export function orderSidebarInbox(sessions: readonly Session[], activity: Readonly<Record<string, string>>, runningSessionIds: ReadonlySet<string>): Session[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()]
    .sort((left, right) => Number(runningSessionIds.has(right.id)) - Number(runningSessionIds.has(left.id)) || sidebarInboxTime(right, activity) - sidebarInboxTime(left, activity) || left.id.localeCompare(right.id));
}

export function sidebarInboxTime(session: Session, activity: Readonly<Record<string, string>>): number {
  const retained = typeof session.metadata?.sidebarActivityAt === "string" ? session.metadata.sidebarActivityAt : null;
  return Math.max(Date.parse(activity[session.id] ?? "") || 0, Date.parse(retained ?? session.createdAt) || 0);
}

export function sidebarInboxDateGroups(sessions: readonly Session[], activity: Readonly<Record<string, string>>, runningSessionIds: ReadonlySet<string>, now = new Date()) {
  return sidebarInboxEntryDateGroups(sessions, session => ({
    time: sidebarInboxTime(session, activity), running: runningSessionIds.has(session.id),
  }), now).map(group => ({ key: group.key, label: group.label, sessions: group.entries }));
}

export function sidebarInboxEntryDateGroups<T>(entries: readonly T[], resolve: (entry: T) => { time: number; running: boolean }, now = new Date()) {
  const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const groups: Array<{ key: string; label: string | null; entries: T[] }> = [];
  for (const entry of entries) {
    const { time, running } = resolve(entry);
    const date = new Date(time);
    const key = running ? "running" : day(date);
    let group = groups.at(-1);
    if (group?.key !== key) {
      group = { key, label: running || key === day(now) ? null : key === day(yesterday) ? "Yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}
