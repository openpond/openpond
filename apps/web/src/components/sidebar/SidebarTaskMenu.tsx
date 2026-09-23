import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArchiveRestore,
  Bookmark,
  BookmarkX,
  Check,
  MoreHorizontal,
  PanelRight,
  Pin,
  PinOff,
  SquarePen,
} from "../icons";
import "../../styles/sidebar/task-menu.css";

export function SidebarTaskMenu({
  title,
  pinned,
  savedForLater,
  archived,
  onRename,
  onTogglePin,
  onToggleSaveForLater,
  onDockRight,
  onArchive,
}: {
  title: string;
  pinned: boolean;
  savedForLater: boolean;
  archived: boolean;
  onRename?: () => void;
  onTogglePin: () => void;
  onToggleSaveForLater?: () => void;
  onDockRight?: () => void;
  onArchive: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const items = [
    ...(onRename
      ? [{ label: "Rename", Icon: SquarePen, action: onRename }]
      : []),
    {
      label: pinned ? "Unpin" : "Pin",
      Icon: pinned ? PinOff : Pin,
      action: onTogglePin,
    },
    ...(onToggleSaveForLater
      ? [
          {
            label: savedForLater ? "Return to active" : "Save for later",
            Icon: savedForLater ? BookmarkX : Bookmark,
            action: onToggleSaveForLater,
          },
        ]
      : []),
    ...(onDockRight
      ? [
          {
            label: "Open in right panel",
            Icon: PanelRight,
            action: onDockRight,
          },
        ]
      : []),
    {
      label: archived ? "Reopen" : "Mark done",
      Icon: archived ? ArchiveRestore : Check,
      action: onArchive,
    },
  ];
  function close(restoreFocus = false) {
    setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setPosition(null);
    };
    const reposition = () => setPosition(null);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", reposition);
    };
  }, [position]);
  return (
    <>
      <div
        className={`sidebar-row-actions sidebar-task-menu-trigger${position ? " is-open" : ""}`}
      >
        <button
          ref={trigger}
          type="button"
          className="sidebar-row-action"
          aria-label={`More actions for task ${title}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(position)}
          draggable={false}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (position) {
              close(true);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition({
              left: Math.max(
                8,
                Math.min(rect.right - 192, window.innerWidth - 200),
              ),
              top: Math.max(
                8,
                Math.min(
                  rect.bottom + 4,
                  window.innerHeight - (items.length * 32 + 17),
                ),
              ),
            });
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={`Actions for ${title}`}
            className="sidebar-task-menu"
            style={position}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                close();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
                ),
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            {items.map(({ label, Icon, action }, index) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className={
                  index === items.length - 1 ? "task-menu-done" : undefined
                }
                onClick={() => {
                  close(true);
                  action();
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
