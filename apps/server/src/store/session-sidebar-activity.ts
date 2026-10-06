import type { RuntimeEvent, Session } from "@openpond/contracts";

const BOUNDARIES = new Set([
  "turn.started", "turn.completed", "turn.failed", "turn.interrupted",
  "approval.requested", "approval.resolved", "task.input", "task.wait",
]);

/** Durable ordering survives event pagination; presentation mutations do not bump it. */
export function sessionWithSidebarActivity(session: Session, event: RuntimeEvent): Session {
  if (!BOUNDARIES.has(event.name) || event.sessionId !== session.id) return session;
  const timestamp = Date.parse(event.timestamp);
  const previous = Date.parse(typeof session.metadata?.sidebarActivityAt === "string" ? session.metadata.sidebarActivityAt : session.createdAt);
  if (!Number.isFinite(timestamp) || timestamp <= (Number.isFinite(previous) ? previous : 0)) return session;
  return { ...session, metadata: { ...session.metadata, sidebarActivityAt: event.timestamp } };
}
