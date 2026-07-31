import { useEffect, useState } from "react";

const SIDEBAR_RUNTIME_TICK_MS = 30_000;

export function useSidebarRuntimeClock(enabled: boolean): string {
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!enabled) return undefined;
    const update = () => setObservedAt(new Date().toISOString());
    update();
    const interval = window.setInterval(update, SIDEBAR_RUNTIME_TICK_MS);
    return () => window.clearInterval(interval);
  }, [enabled]);

  return observedAt;
}
