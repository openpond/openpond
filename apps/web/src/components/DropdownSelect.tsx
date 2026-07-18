import { useEffect, useRef, useState } from "react";
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
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
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
        <div className="dropdown-menu" role="menu">
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
              className={[
                option.value === value ? "selected" : "",
                option.separatorBefore ? "separator-before" : "",
                option.icon ? "with-icon" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => {
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
