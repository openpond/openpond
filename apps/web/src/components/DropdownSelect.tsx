import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Plus } from "./icons";
import type { DropdownOption } from "../lib/app-models";

export function DropdownSelect({
  value,
  options,
  disabled,
  compact,
  className,
  icon,
  placement = "bottom",
  label,
  tooltip,
  searchable = false,
  floating = false,
  onChange,
}: {
  value: string;
  options: DropdownOption[];
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  icon?: ReactNode;
  placement?: "bottom" | "top";
  label: string;
  tooltip?: string;
  searchable?: boolean;
  floating?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !floating) return;
    function position() {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 180 && above > below;
      setMenuStyle({ position: "fixed", left: Math.max(12, rect.left), width: Math.min(rect.width, window.innerWidth - 24), minWidth: 0, maxWidth: "calc(100vw - 24px)", right: "auto", top: upward ? "auto" : rect.bottom + 5, bottom: upward ? window.innerHeight - rect.top + 5 : "auto", maxHeight: Math.max(80, Math.min(320, upward ? above - 5 : below - 5)), overflowY: "auto", zIndex: 1000 });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, floating]);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) =>
        [option.label, option.shortLabel, option.description]
          .some((candidate) => candidate?.toLowerCase().includes(normalizedQuery)))
    : options;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      className={`dropdown-select ${className ?? ""} ${compact ? "compact" : ""} ${placement === "top" ? "open-up" : ""}`}
      data-tooltip={tooltip}
      ref={menuRef}
    >
      <button
        type="button"
        className={`dropdown-trigger ${open ? "active" : ""}`}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span>{selected?.shortLabel ?? selected?.label ?? value}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="dropdown-menu" role="menu" style={floating ? menuStyle : undefined}>
          {searchable ? (
            <label className="dropdown-search" onClick={(event) => event.stopPropagation()}>
              <span className="sr-only">Search {label}</span>
              <input
                autoFocus
                placeholder={`Search ${label.toLowerCase()}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              disabled={option.disabled}
              className={[
                option.value === value ? "selected" : "",
                option.separatorBefore ? "separator-before" : "",
                option.icon ? "with-icon" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setQuery("");
                setOpen(false);
              }}
            >
              <span>
                {option.icon === "plus" ? <Plus size={13} /> : null}
                <span>{option.label}</span>
              </span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
          {!visibleOptions.length ? <div className="dropdown-empty">No matches</div> : null}
        </div>
      )}
    </div>
  );
}
