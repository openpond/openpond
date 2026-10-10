import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export type WorkspaceMenuAction = {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
};

/** Secondary page actions share the dropdown menu surface instead of a row of buttons. */
export function WorkspaceActionMenu({
  label,
  actions,
}: {
  label: string;
  actions: WorkspaceMenuAction[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (!actions.length) return null;
  return (
    <div className="dropdown-select evaluation-action-menu" ref={root}>
      <button
        type="button"
        className="training-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div className="dropdown-menu" role="menu">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              <span>
                <span>{action.label}</span>
              </span>
              {action.description ? <small>{action.description}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
