import type { ActivityItem } from "../../lib/app-models";

const MAX_SUMMARY_SUBAGENT_AVATARS = 4;

type SubagentOpenSession = NonNullable<ActivityItem["openSession"]>;

export function SubagentAvatarGroup({
  onOpenSession,
  onShowAll,
  sessions,
}: {
  onOpenSession: (sessionId: string) => void;
  onShowAll: () => void;
  sessions: SubagentOpenSession[];
}) {
  const visible = sessions.slice(0, MAX_SUMMARY_SUBAGENT_AVATARS);
  const hiddenCount = Math.max(0, sessions.length - visible.length);
  const label = sessions.map(subagentAvatarLabel).join(", ");
  return (
    <div
      aria-label={`Subagent conversations: ${label}`}
      className="activity-subagent-avatar-group"
      title={`Subagent conversations: ${label}`}
    >
      {visible.map((openSession) => (
        <SubagentAvatarButton
          key={openSession.sessionId}
          openSession={openSession}
          onOpenSession={onOpenSession}
        />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-label={`Show ${hiddenCount} more subagent conversation${
            hiddenCount === 1 ? "" : "s"
          }`}
          className="activity-subagent-avatar activity-subagent-avatar-count"
          onClick={onShowAll}
          title={`Show ${hiddenCount} more subagent conversation${
            hiddenCount === 1 ? "" : "s"
          }`}
        >
          +{hiddenCount}
        </button>
      ) : null}
    </div>
  );
}

export function SubagentAvatarButton({
  className = "",
  onOpenSession,
  openSession,
}: {
  className?: string;
  onOpenSession: (sessionId: string) => void;
  openSession: SubagentOpenSession;
}) {
  const roleId = normalizedSubagentRole(openSession.roleId);
  const status = normalizedSubagentStatus(openSession.status);
  const label = `Open ${subagentAvatarLabel(openSession)} conversation`;
  return (
    <button
      type="button"
      aria-label={label}
      className={`activity-subagent-avatar ${className}`}
      data-role={roleId}
      data-status={status}
      onClick={() => onOpenSession(openSession.sessionId)}
      title={label}
    >
      <SubagentRoleGlyph roleId={roleId} />
    </button>
  );
}

function SubagentRoleGlyph({ roleId }: { roleId: string }) {
  if (roleId === "coding") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M9.4 7.2 4.8 12l4.6 4.8" />
        <path d="m14.6 7.2 4.6 4.8-4.6 4.8" />
        <path d="m12.9 5.7-1.8 12.6" />
      </svg>
    );
  }
  if (roleId === "research") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <circle cx="10.8" cy="10.8" r="5.2" />
        <path d="m15 15 4 4" />
        <path d="M8.6 10.8h4.4" />
        <path d="M10.8 8.6v4.4" />
      </svg>
    );
  }
  if (roleId === "review") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M7 4.8h7.2L18 8.6v10.6H7z" />
        <path d="M14 4.8v4h4" />
        <path d="m8.9 14.2 2 2 4.3-4.7" />
      </svg>
    );
  }
  if (roleId === "test") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M9.2 4.8h5.6" />
        <path d="M10.4 4.8v5.4l-4 6.8a1.8 1.8 0 0 0 1.6 2.7h8a1.8 1.8 0 0 0 1.6-2.7l-4-6.8V4.8" />
        <path d="M8.2 15.8h7.6" />
      </svg>
    );
  }
  if (roleId === "docs") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M7 4.8h7.2L18 8.6v10.6H7z" />
        <path d="M14 4.8v4h4" />
        <path d="M9.2 11.4h5.6" />
        <path d="M9.2 14.2h5.6" />
        <path d="M9.2 17h3.4" />
      </svg>
    );
  }
  if (roleId === "planner") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <circle cx="7.2" cy="7.2" r="2.1" />
        <circle cx="16.8" cy="7.2" r="2.1" />
        <circle cx="12" cy="16.8" r="2.1" />
        <path d="M9 8.2h6" />
        <path d="m8.5 9 2.4 5.4" />
        <path d="m15.5 9-2.4 5.4" />
      </svg>
    );
  }
  if (roleId === "summarizer") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
        <path d="M7 6.8h10" />
        <path d="M7 10.4h8.2" />
        <path d="M7 14h6.2" />
        <path d="M7 17.6h4.2" />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="activity-subagent-avatar-svg">
      <circle cx="12" cy="8.2" r="3.2" />
      <path d="M6.5 19.2c.6-3 2.5-5 5.5-5s4.9 2 5.5 5" />
      <path d="M5.2 11.8h2" />
      <path d="M16.8 11.8h2" />
    </svg>
  );
}

export function subagentOpenSessions(
  activities: ActivityItem[]
): SubagentOpenSession[] {
  const bySession = new Map<string, SubagentOpenSession>();
  for (const activity of activities) {
    const openSession = activity.openSession;
    if (!openSession) continue;
    bySession.set(openSession.sessionId, {
      ...bySession.get(openSession.sessionId),
      ...openSession,
    });
  }
  return [...bySession.values()].reverse();
}

function subagentAvatarLabel(openSession: SubagentOpenSession): string {
  const role = `${subagentRoleLabel(openSession.roleId)} subagent`;
  const status = openSession.status?.replace(/_/g, " ").trim();
  return status ? `${role} (${status})` : role;
}

export function subagentRoleLabel(roleId: string | undefined): string {
  const normalized = normalizedSubagentRole(roleId);
  return (
    normalized
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ") || "Subagent"
  );
}

function normalizedSubagentRole(roleId: string | undefined): string {
  const value = roleId?.trim().toLowerCase() || "subagent";
  return /^[a-z][a-z0-9_-]*$/.test(value) ? value : "subagent";
}

function normalizedSubagentStatus(status: string | undefined): string {
  const value = status?.trim().toLowerCase() || "unknown";
  return /^[a-z][a-z0-9_-]*$/.test(value) ? value : "unknown";
}
