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
  triggerContent,
  placement = "bottom",
  label,
  tooltip,
  searchable = false,
  floating = false,
  floatingMenuWidth,
  floatingMenuMaxHeight = 320,
  openOnHover = false,
  onChange,
}: {
  value: string;
  options: DropdownOption[];
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  icon?: ReactNode;
  triggerContent?: ReactNode;
  placement?: "bottom" | "top";
  label: string;
  tooltip?: string;
  searchable?: boolean;
  floating?: boolean;
  floatingMenuWidth?: number;
  floatingMenuMaxHeight?: number;
  openOnHover?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverPreview = useRef(false);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelHoverClose() {
    if (hoverCloseTimer.current !== null) clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  }
  function closeMenu() {
    cancelHoverClose();
    hoverPreview.current = false;
    setOpen(false);
  }
  useEffect(() => () => {
    if (hoverCloseTimer.current !== null) clearTimeout(hoverCloseTimer.current);
  }, []);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !floating) return;
    function position() {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 180 && above > below;
      const width = Math.min(floatingMenuWidth ?? rect.width, window.innerWidth - 24);
      setMenuStyle({ position: "fixed", left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, minWidth: 0, maxWidth: "calc(100vw - 24px)", right: "auto", top: upward ? "auto" : rect.bottom + 5, bottom: upward ? window.innerHeight - rect.top + 5 : "auto", maxHeight: Math.max(80, Math.min(floatingMenuMaxHeight, upward ? above - 5 : below - 5)), overflowY: "auto", zIndex: 1000 });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, floating, floatingMenuWidth, floatingMenuMaxHeight]);
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
      if (!menuRef.current?.contains(event.target as Node)) closeMenu();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const hadFocus = menuRef.current?.contains(document.activeElement);
        closeMenu();
        if (hadFocus) triggerRef.current?.focus();
      }
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
      onPointerEnter={openOnHover ? (event) => {
        if (disabled || event.pointerType === "touch") return;
        cancelHoverClose();
        if (!open) {
          hoverPreview.current = true;
          setOpen(true);
        }
      } : undefined}
      onPointerLeave={openOnHover ? () => {
        if (!hoverPreview.current) return;
        cancelHoverClose();
        hoverCloseTimer.current = setTimeout(() => {
          if (!menuRef.current?.contains(document.activeElement)) closeMenu();
        }, 180);
      } : undefined}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`dropdown-trigger ${open ? "active" : ""}`}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          cancelHoverClose();
          if (hoverPreview.current) {
            hoverPreview.current = false;
            setOpen(true);
          } else if (open) closeMenu();
          else setOpen(true);
        }}
      >
        {triggerContent ?? <>
          {icon}
          <span>{selected?.shortLabel ?? selected?.label ?? value}</span>
          <ChevronDown size={14} />
        </>}
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
                closeMenu();
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
