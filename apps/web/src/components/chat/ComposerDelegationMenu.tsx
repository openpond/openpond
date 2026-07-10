import { useEffect, useRef, useState } from "react";
import type { SubagentDelegationMode } from "@openpond/contracts";
import { Check } from "../icons";

const DELEGATION_OPTIONS: Array<{
  mode: SubagentDelegationMode;
  label: string;
  description: string;
}> = [
  {
    mode: "manual",
    label: "Manual",
    description: "Only delegate when you ask.",
  },
  {
    mode: "balanced",
    label: "Balanced",
    description: "Delegate bounded work when it helps.",
  },
  {
    mode: "proactive",
    label: "Proactive",
    description: "Prefer independent parallel workers.",
  },
];

function modeLabel(mode: SubagentDelegationMode): string {
  return DELEGATION_OPTIONS.find((option) => option.mode === mode)?.label ?? mode;
}

export function ComposerDelegationMenu({
  defaultMode,
  disabled,
  overrideMode,
  onChange,
}: {
  defaultMode: SubagentDelegationMode;
  disabled: boolean;
  overrideMode: SubagentDelegationMode | null;
  onChange: (mode: SubagentDelegationMode | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const effectiveMode = overrideMode ?? defaultMode;
  const tooltip = `Subagent use: ${modeLabel(effectiveMode)}${overrideMode ? "" : " (default)"}`;

  useEffect(() => {
    if (!open) return undefined;
    function closeOnPointerDown(event: PointerEvent) {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="composer-delegation-control open-up" ref={controlRef}>
      <button
        type="button"
        className={`composer-icon composer-delegation-trigger ${open ? "active" : ""}`}
        aria-label={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={tooltip}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">SUB</span>
      </button>
      {open ? (
        <div className="composer-delegation-menu" role="menu" aria-label="Subagent use">
          <div className="composer-delegation-menu-title">Subagent use</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={overrideMode === null}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <span className="composer-delegation-check">
              {overrideMode === null ? <Check size={14} /> : null}
            </span>
            <span>
              <strong>Use default</strong>
              <small>{modeLabel(defaultMode)}</small>
            </span>
          </button>
          <div className="composer-add-menu-divider" role="presentation" />
          {DELEGATION_OPTIONS.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={overrideMode === option.mode}
              key={option.mode}
              onClick={() => {
                onChange(option.mode);
                setOpen(false);
              }}
            >
              <span className="composer-delegation-check">
                {overrideMode === option.mode ? <Check size={14} /> : null}
              </span>
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
