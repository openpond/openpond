import { useEffect, useState } from "react";

const GOAL_RUNTIME_TICK_MS = 1_000;

export function useGoalRuntimeClock(enabled: boolean): string {
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!enabled) return undefined;
    const update = () => setObservedAt(new Date().toISOString());
    update();
    const interval = window.setInterval(update, GOAL_RUNTIME_TICK_MS);
    return () => window.clearInterval(interval);
  }, [enabled]);

  return observedAt;
}
