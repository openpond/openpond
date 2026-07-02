import type { ReactNode } from "react";
import { X } from "../icons";

export function ComposerInvocationPill({
  icon,
  label,
  onRemove,
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="composer-invocation-pill" contentEditable={false} data-inline-token="true">
      <button
        type="button"
        className="composer-invocation-remove"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <span className="composer-invocation-icon" aria-hidden="true">
          {icon}
        </span>
        <X className="composer-invocation-clear" size={13} aria-hidden="true" />
      </button>
      <span className="composer-invocation-label">{label}</span>
    </span>
  );
}
