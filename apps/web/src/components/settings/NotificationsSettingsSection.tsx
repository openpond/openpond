import { useCallback, useMemo, useState } from "react";
import type { TeamChatThread } from "@openpond/contracts";
import type { TeamChatNotificationMode } from "../../lib/team-chat-notifications";
import { Bell, BellOff } from "../icons";

const NOTIFICATION_OPTIONS: Array<{
  mode: TeamChatNotificationMode;
  label: string;
  detail: string;
}> = [
  {
    mode: "all",
    label: "All new messages",
    detail: "Show an in-app alert for every Team Chat message.",
  },
  {
    mode: "direct_mentions",
    label: "Direct messages and mentions",
    detail: "Show alerts for direct messages and messages that mention you.",
  },
  {
    mode: "none",
    label: "Nothing",
    detail: "Keep unread counts without showing message alerts.",
  },
];

type NotificationsSettingsSectionProps = {
  currentUserId: string | null;
  enabled: boolean;
  mode: TeamChatNotificationMode;
  threads: TeamChatThread[];
  onModeChange: (mode: TeamChatNotificationMode) => void;
  onThreadMuteChange: (threadId: string, muted: boolean) => Promise<boolean>;
};

export function NotificationsSettingsSection({
  currentUserId,
  enabled,
  mode,
  threads,
  onModeChange,
  onThreadMuteChange,
}: NotificationsSettingsSectionProps) {
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [muteError, setMuteError] = useState<string | null>(null);
  const visibleThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null)
        .map((thread) => ({
          thread,
          label: teamChatSettingsThreadLabel(thread, currentUserId),
        }))
        .sort((left, right) => {
          const muteOrder = Number(Boolean(right.thread.mutedAt)) - Number(Boolean(left.thread.mutedAt));
          if (muteOrder !== 0) return muteOrder;
          return left.label.localeCompare(right.label);
        }),
    [currentUserId, threads],
  );
  const mutedCount = visibleThreads.filter(({ thread }) => Boolean(thread.mutedAt)).length;
  const updateThreadMute = useCallback(
    async (thread: TeamChatThread) => {
      setBusyThreadId(thread.id);
      setMuteError(null);
      const updated = await onThreadMuteChange(thread.id, !thread.mutedAt);
      if (!updated) setMuteError("Could not update this conversation. Try again.");
      setBusyThreadId(null);
    },
    [onThreadMuteChange],
  );

  return (
    <section className="account-settings notifications-settings">
      <h1>Notifications</h1>

      <div className="account-list notification-settings-card">
        <div className="account-list-heading">
          <span>Team chat notifications</span>
          <small>In-app alerts</small>
        </div>
        <div className="notification-mode-list" role="radiogroup" aria-label="Notify me about">
          {NOTIFICATION_OPTIONS.map((option) => (
            <label
              className={`notification-mode-option${mode === option.mode ? " selected" : ""}`}
              key={option.mode}
            >
              <input
                type="radio"
                name="team-chat-notification-mode"
                checked={mode === option.mode}
                onChange={() => onModeChange(option.mode)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="account-list notification-settings-card">
        <div className="account-list-heading">
          <span>Conversation overrides</span>
          <small>{mutedCount === 1 ? "1 muted" : `${mutedCount} muted`}</small>
        </div>
        {!enabled ? (
          <div className="empty-account-list">
            <span>Connect a team to manage conversation overrides.</span>
          </div>
        ) : visibleThreads.length === 0 ? (
          <div className="empty-account-list">
            <span>Open a Team Chat conversation to manage it here.</span>
          </div>
        ) : (
          visibleThreads.map(({ thread, label }) => {
            const muted = Boolean(thread.mutedAt);
            const busy = busyThreadId === thread.id;
            return (
              <div className="notification-thread-row" key={thread.id}>
                <span className={`notification-thread-icon${muted ? " muted" : ""}`}>
                  {muted ? <BellOff size={15} /> : <Bell size={15} />}
                </span>
                <span className="notification-thread-copy">
                  <strong>{label}</strong>
                  <small>{muted ? "Muted" : "Uses the team chat setting"}</small>
                </span>
                <button
                  type="button"
                  className="settings-secondary"
                  disabled={busyThreadId !== null}
                  onClick={() => void updateThreadMute(thread)}
                >
                  {busy ? "Saving" : muted ? "Unmute" : "Mute"}
                </button>
              </div>
            );
          })
        )}
        {muteError ? (
          <div className="notification-settings-error" role="alert">
            {muteError}
          </div>
        ) : null}
      </div>

      <div className="settings-footnote">
        <span>Muted conversations never show alerts. Unread counts remain available.</span>
      </div>
    </section>
  );
}

export function teamChatSettingsThreadLabel(
  thread: TeamChatThread,
  currentUserId: string | null,
): string {
  if (thread.kind === "general" || thread.kind === "channel") {
    return `#${thread.title?.trim() || "general"}`;
  }
  if (thread.kind === "dm") {
    return (
      thread.participants.find((participant) => participant.userId !== currentUserId)?.name ??
      thread.title?.trim() ??
      "Direct message"
    );
  }
  return (
    thread.title?.trim() ||
    thread.participants
      .filter((participant) => participant.userId !== currentUserId)
      .map((participant) => participant.name)
      .join(", ") ||
    "Group conversation"
  );
}
