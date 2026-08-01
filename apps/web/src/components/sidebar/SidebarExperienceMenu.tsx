import type { Experience } from "@openpond/contracts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EXPERIENCE_OPTIONS } from "../../lib/experience-options";
import { OPENPOND_WORDMARK_WHITE_URL } from "../../lib/public-assets";
import { Check, ChevronDown } from "../icons";

export function SidebarExperienceMenu({
  value,
  onChange,
}: {
  value: Experience;
  onChange: (experience: Experience) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeOption =
    EXPERIENCE_OPTIONS.find((option) => option.value === value) ??
    EXPERIENCE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnBlur = () => setOpen(false);
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);

  const focusOption = (position: "first" | "last" | "active") => {
    window.requestAnimationFrame(() => {
      const options = menuOptions(menuRef.current);
      if (!options.length) return;
      const target =
        position === "first"
          ? options[0]
          : position === "last"
          ? options.at(-1)
          : options.find((option) => option.dataset.experience === value);
      target?.focus();
    });
  };

  const openFromKeyboard = (position: "first" | "last" | "active") => {
    setOpen(true);
    focusOption(position);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openFromKeyboard("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openFromKeyboard("last");
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = menuOptions(menuRef.current);
    const currentIndex = options.findIndex(
      (option) => option === document.activeElement
    );
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      options[event.key === "Home" ? 0 : options.length - 1]?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + direction + options.length) % options.length;
    options[nextIndex]?.focus();
  };

  return (
    <div className="sidebar-experience-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sidebar-wordmark-button sidebar-experience-trigger"
        aria-label={`OpenPond experience: ${activeOption.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <img
          className="sidebar-wordmark"
          src={OPENPOND_WORDMARK_WHITE_URL}
          alt=""
        />
        <span className="sidebar-experience-label">{activeOption.label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="sidebar-experience-popover"
          role="menu"
          aria-label="Choose experience"
          onKeyDown={onMenuKeyDown}
        >
          {EXPERIENCE_OPTIONS.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={selected ? "active" : ""}
                data-experience={option.value}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange(option.value);
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {selected ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function menuOptions(root: HTMLDivElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
  );
}
