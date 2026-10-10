import { useCallback, useEffect, useRef, useState } from "react";
import type { AppToast } from "../lib/app-toasts";
import { ToastLifecycle, type ToastPresentation } from "../lib/toast-lifecycle";

export function useToastPresentation(toasts: AppToast[], onDismiss: (id: number) => void, scope: string) {
  const lifecycleRef = useRef({ scope, lifecycle: new ToastLifecycle() });
  const [cards, setCards] = useState<ToastPresentation[]>([]);
  const [revision, setRevision] = useState(0);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const activeScopeRef = useRef(scope);
  activeScopeRef.current = scope;
  useEffect(() => {
    if (lifecycleRef.current.scope !== scope) {
      lifecycleRef.current = { scope, lifecycle: new ToastLifecycle() };
      capacityRef.current = 3;
      setCards([]);
      return;
    }
    const lifecycle = lifecycleRef.current.lifecycle;
    lifecycle.sync(toasts, Date.now());
    for (const id of lifecycle.tick(Date.now())) dismissRef.current(id);
    setCards(lifecycle.snapshot());
    const deadline = lifecycle.nextDeadline();
    if (deadline === null) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [toasts, revision, scope]);
  const onPause = useCallback((id: number, paused: boolean) => {
    lifecycleRef.current.lifecycle.pause(id, paused, Date.now());
    setRevision(value => value + 1);
  }, []);
  const capacityRef = useRef(3);
  const onCapacity = useCallback((capacity: number) => {
    if (capacityRef.current === capacity) return;
    capacityRef.current = capacity;
    lifecycleRef.current.lifecycle.setCapacity(capacity, Date.now());
    setRevision(value => value + 1);
  }, []);
  const isCurrent = useCallback(() => activeScopeRef.current === scope, [scope]);
  return { cards: lifecycleRef.current.scope === scope ? cards : [], onDismiss, onPause, onCapacity, isCurrent };
}
