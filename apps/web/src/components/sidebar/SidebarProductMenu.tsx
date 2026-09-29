import type { ProductArea } from "@openpond/contracts";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { PRODUCT_AREA_OPTIONS } from "../../lib/experience-options";
import { OPENPOND_WORDMARK_WHITE_URL } from "../../lib/public-assets";
import { Check, ChevronDown } from "../icons";

export function SidebarProductMenu({
  value,
  onChange,
}: {
  value: ProductArea;
  onChange: (productArea: ProductArea) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<"first" | "last" | null>(null);
  const activeOption =
    PRODUCT_AREA_OPTIONS.find((option) => option.value === value) ??
    PRODUCT_AREA_OPTIONS[0];

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

  useLayoutEffect(() => {
    if (open && pendingFocusRef.current) focusMenuOption(menuRef.current, pendingFocusRef.current);
    pendingFocusRef.current = null;
  }, [open]);

  const openFromKeyboard = (position: "first" | "last") => {
    if (open) {
      focusMenuOption(menuRef.current, position);
      return;
    }
    pendingFocusRef.current = position;
    setOpen(true);
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
        aria-label={`OpenPond product: ${activeOption.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          pendingFocusRef.current = null;
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
          aria-label="Choose product"
          onKeyDown={onMenuKeyDown}
        >
          {PRODUCT_AREA_OPTIONS.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={selected ? "active" : ""}
                data-product-area={option.value}
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

function focusMenuOption(root: HTMLDivElement | null, position: "first" | "last"): void {
  const options = menuOptions(root);
  (position === "first" ? options[0] : options.at(-1))?.focus();
}
