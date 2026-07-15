import { useEffect, useRef, useState } from "react";
import type { TeamChatThread } from "@openpond/contracts";
import type { TeamChatNotificationMode } from "../../lib/team-chat-notifications";
import { Bell, BellOff, Check } from "../icons";

const NOTIFICATION_OPTIONS: Array<{
  mode: TeamChatNotificationMode;
  label: string;
  detail: string;
}> = [
  { mode: "all", label: "All new messages", detail: "Channels and direct messages" },
  {
    mode: "direct_mentions",
    label: "Direct messages & mentions",
    detail: "Quieter, but still personal",
  },
  { mode: "none", label: "Nothing", detail: "Keep unread counts only" },
];

export function TeamChatNotificationMenu(props: {
  mode: TeamChatNotificationMode;
  currentThread: TeamChatThread | null;
  currentThreadLabel: string | null;
  onModeChange: (mode: TeamChatNotificationMode) => void;
  onThreadMuteChange: (threadId: string, muted: boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const muted = Boolean(props.currentThread?.mutedAt);
  const notificationsOff = props.mode === "none";

  return (
    <div
      className="team-notification-menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`section-icon${open ? " active" : ""}`}
        data-tooltip="Team notifications"
        aria-label="Team notification settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {notificationsOff ? <BellOff size={14} /> : <Bell size={14} />}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="team-notification-popover"
          role="menu"
          aria-label="Team notifications"
        >
          <strong>Notify me about</strong>
          {NOTIFICATION_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="menuitemradio"
              aria-checked={props.mode === option.mode}
              onClick={() => {
                props.onModeChange(option.mode);
                setOpen(false);
              }}
            >
              <span className="team-notification-check">
                {props.mode === option.mode ? <Check size={13} /> : null}
              </span>
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </button>
          ))}
          {props.currentThread && props.currentThreadLabel ? (
            <>
              <div className="team-notification-divider" />
              <button
                type="button"
                role="menuitem"
                disabled={muteBusy}
                onClick={() => {
                  setMuteBusy(true);
                  void props
                    .onThreadMuteChange(props.currentThread!.id, !muted)
                    .then((updated) => {
                      if (updated) setOpen(false);
                    })
                    .finally(() => setMuteBusy(false));
                }}
              >
                <span className="team-notification-check">
                  {muted ? <Bell size={13} /> : <BellOff size={13} />}
                </span>
                <span>
                  <strong>
                    {muted ? "Unmute" : "Mute"} {props.currentThreadLabel}
                  </strong>
                  <small>Unread counts remain visible</small>
                </span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
