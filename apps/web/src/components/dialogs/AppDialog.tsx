import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

const dialogStack: symbol[] = [];

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

export function AppDialog({
  ariaLabel,
  backdropClassName = "training-dialog-backdrop",
  children,
  className,
  contained = false,
  dismissDisabled = false,
  initialFocusKey,
  inertExclusionSelector,
  onClose,
}: {
  ariaLabel: string;
  backdropClassName?: string;
  children: ReactNode;
  className: string;
  contained?: boolean;
  dismissDisabled?: boolean;
  initialFocusKey?: unknown;
  inertExclusionSelector?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const instanceRef = useRef(Symbol("app-dialog"));
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dismissDisabledRef = useRef(dismissDisabled);
  const onCloseRef = useRef(onClose);
  dismissDisabledRef.current = dismissDisabled;
  onCloseRef.current = onClose;

  useEffect(() => {
    const instance = instanceRef.current;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogStack.push(instance);
    const inertBoundary = contained
      ? dialogRef.current?.closest<HTMLElement>(".main-pane") ?? null
      : null;
    const restoreInert = makeBackgroundInert(
      dialogRef.current,
      inertBoundary,
      inertExclusionSelector,
    );

    function handleKeyDown(event: KeyboardEvent) {
      if (dialogStack.at(-1) !== instance) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!dismissDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || contained) return;
      trapTabFocus(event, dialogRef.current);
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const index = dialogStack.lastIndexOf(instance);
      if (index >= 0) dialogStack.splice(index, 1);
      restoreInert();
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [contained, inertExclusionSelector]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const target = dialog?.querySelector<HTMLElement>("[data-autofocus]")
        ?? dialog;
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusKey]);

  function handleBackdropMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !dismissDisabled) onClose();
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") event.stopPropagation();
  }

  return (
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <section
        ref={dialogRef}
        aria-busy={dismissDisabled || undefined}
        aria-label={ariaLabel}
        aria-modal={contained ? undefined : "true"}
        className={className}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function trapTabFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const focusable = focusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = event.shiftKey
    ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
    : activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1;
  event.preventDefault();
  focusable[nextIndex]?.focus();
}

function makeBackgroundInert(
  dialog: HTMLElement | null,
  boundary: HTMLElement | null = null,
  exclusionSelector?: string,
): () => void {
  if (!dialog) return () => undefined;
  const changes: Array<{
    element: HTMLElement;
    ariaHidden: string | null;
    inert: boolean;
  }> = [];
  let branch: HTMLElement = dialog.parentElement ?? dialog;
  while (branch.parentElement && branch !== document.body) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      if (exclusionSelector && sibling.matches(exclusionSelector)) continue;
      changes.push({
        element: sibling,
        ariaHidden: sibling.getAttribute("aria-hidden"),
        inert: sibling.inert,
      });
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    branch = parent;
    if (boundary && branch === boundary) break;
  }
  return () => {
    for (const change of changes.reverse()) {
      change.element.inert = change.inert;
      if (change.ariaHidden === null) change.element.removeAttribute("aria-hidden");
      else change.element.setAttribute("aria-hidden", change.ariaHidden);
    }
  };
}
