import type { ReactNode } from "react";
import { ChevronDown } from "../icons";

export function ChatActivitySummary({
  children,
  className = "",
  controls,
  danger = false,
  expanded = false,
  icon,
  onToggle,
  running = false,
}: {
  children: ReactNode;
  className?: string;
  controls?: string;
  danger?: boolean;
  expanded?: boolean;
  icon?: ReactNode;
  onToggle?: () => void;
  running?: boolean;
}) {
  const classes = [
    "activity-summary",
    onToggle ? "" : "static",
    danger ? "danger" : "",
    running ? "working" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      {icon}
      <span className="activity-summary-text">
        <span>{children}</span>
      </span>
      {onToggle ? (
        <ChevronDown
          aria-hidden
          className={`activity-summary-toggle ${expanded ? "expanded" : ""}`}
          size={14}
        />
      ) : null}
    </>
  );

  return onToggle ? (
    <button
      type="button"
      aria-controls={controls}
      aria-expanded={expanded}
      className={classes}
      onClick={onToggle}
    >
      {content}
    </button>
  ) : (
    <div className={classes} role={running ? "status" : undefined}>
      {content}
    </div>
  );
}
