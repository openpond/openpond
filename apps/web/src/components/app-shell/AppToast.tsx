import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "../icons";
import type { ToastPresentation } from "../../lib/toast-lifecycle";
import { errorMessageForToast } from "../../lib/error-messages";

type AppToastProps = {
  cards: ToastPresentation[];
  onDismiss: (id: number) => void;
  onPause: (id: number, paused: boolean) => void;
  onCapacity: (capacity: number) => void;
  isCurrent: () => boolean;
};

export function AppToast({ cards, onDismiss, onPause, onCapacity, isCurrent }: AppToastProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(new Map<number, HTMLDivElement>());
  const positionsRef = useRef(new Map<number, number>());
  const [positions, setPositions] = useState(new Map<number, number>());
  const [busyIds, setBusyIds] = useState(new Set<number>());
  const openingRef = useRef(new Set<number>());
  const [errors, setErrors] = useState(new Map<number, string>());
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const geometryKey = cards.map(card => `${card.toast.id}:${card.phase}:${card.parked}`).join("|");

  useEffect(() => {
    const ids = new Set(cardsRef.current.map(card => card.toast.id));
    setErrors(current => [...current.keys()].every(id => ids.has(id)) ? current
      : new Map([...current].filter(([id]) => ids.has(id))));
  }, [geometryKey]);

  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    function measure() {
      let offset = 0;
      const next = new Map(cardsRef.current.map(card => [card.toast.id, positionsRef.current.get(card.toast.id) ?? 0]));
      const active = cardsRef.current.filter(card => !card.parked && card.phase !== "exiting");
      for (const card of active) {
        next.set(card.toast.id, offset);
        offset += (nodesRef.current.get(card.toast.id)?.offsetHeight ?? 100) + 8;
      }
      const heights = active.map(card => nodesRef.current.get(card.toast.id)?.offsetHeight ?? 100);
      let used = 0;
      let capacity = 0;
      for (let index = 0; index < 3; index++) {
        used += (heights[index] ?? Math.max(100, ...heights)) + (index ? 8 : 0);
        if (used <= region!.clientHeight) capacity++;
      }
      onCapacity(Math.max(1, capacity));
      positionsRef.current = next;
      setPositions(previous => previous.size === next.size && [...next].every(([id, y]) => previous.get(id) === y) ? previous : next);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    for (const node of nodesRef.current.values()) observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [geometryKey, onCapacity]);

  function restoreFocus(id: number) {
    if (!nodesRef.current.get(id)?.contains(document.activeElement)) return;
    const next = [...nodesRef.current].find(([otherId, node]) => otherId !== id && !node.inert);
    if (next) (next[1].querySelector("button") as HTMLButtonElement | null)?.focus();
    else {
      const pane = document.querySelector<HTMLElement>(".main-pane, .settings-content");
      if (pane) { pane.tabIndex = -1; pane.focus({ preventScroll: true }); }
    }
  }

  async function open(card: ToastPresentation) {
    const { toast } = card;
    if (!toast.onAction || openingRef.current.has(toast.id) || !isCurrent()) return;
    openingRef.current.add(toast.id);
    setBusyIds(current => new Set(current).add(toast.id));
    onPause(toast.id, true);
    try {
      const accepted = await toast.onAction();
      if (isCurrent() && accepted !== false) { restoreFocus(toast.id); onDismiss(toast.id); }
    } catch (error) {
      if (isCurrent()) setErrors(current => new Map(current).set(toast.id, errorMessageForToast(error, "Could not open this thread.")));
    } finally {
      openingRef.current.delete(toast.id);
      setBusyIds(current => { const next = new Set(current); next.delete(toast.id); return next; });
      const node = nodesRef.current.get(toast.id);
      onPause(toast.id, Boolean(node?.matches(":hover") || node?.contains(document.activeElement)));
    }
  }

  return (
    <div className="app-toast-region" ref={regionRef} aria-label="Notifications">
      {cards.map(card => {
        const { toast, parked, phase } = card;
        const interactive = Boolean(toast.onAction);
        const busy = busyIds.has(toast.id);
        const error = errors.get(toast.id);
        const title = toast.title ?? (toast.tone === "error" ? "Error" : toast.tone === "success" ? "Success" : "Notification");
        const description = error ?? [toast.message, toast.detail].filter(Boolean).join(" · ");
        const copy = <><span className="app-toast-title" title={title}>{title}</span>
          {description ? <span className={`app-toast-description${error ? " app-toast-action-error" : ""}`}
            title={description} role={error ? "alert" : undefined}>{description}</span> : null}</>;
        return (
          <div key={toast.id} ref={node => { if (node) nodesRef.current.set(toast.id, node); else nodesRef.current.delete(toast.id); }}
            className={`app-toast-position${parked ? " parked" : ""}`} inert={parked || phase === "exiting"}
            style={{ "--toast-y": `${positions.get(toast.id) ?? 0}px` } as CSSProperties}
            onMouseEnter={() => onPause(toast.id, true)}
            onMouseLeave={event => onPause(toast.id, busy || event.currentTarget.contains(document.activeElement))}
            onFocus={() => onPause(toast.id, true)}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onPause(toast.id, busy || event.currentTarget.matches(":hover")); }}>
            <div className={`app-toast ${toast.tone} ${parked ? "" : phase}`} role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"}>
              <button type="button" className="app-toast-close" aria-label="Dismiss notification" onClick={() => {
                restoreFocus(toast.id);
                onDismiss(toast.id);
              }}><X size={14} /></button>
              {interactive ? <button type="button" className="app-toast-body" disabled={busy} onClick={() => void open(card)}>{copy}</button>
                : <div className="app-toast-body">{copy}</div>}
              {interactive ? <div className="app-toast-actions"><button type="button" disabled={busy}
                aria-label={toast.kind ? `Open thread: ${toast.message}` : toast.actionLabel}
                onClick={() => void open(card)}>{busy ? "Opening…" : toast.actionLabel ?? "Open thread"}</button></div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
