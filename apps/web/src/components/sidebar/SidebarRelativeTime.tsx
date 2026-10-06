import { useSyncExternalStore } from "react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

let now = Date.now();
let clock: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const snapshot = () => now;

// All visible timestamps share one clock, which stops when the sidebar unmounts.
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!clock) {
    now = Date.now();
    clock = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(clock);
      clock = undefined;
    }
  };
}

export function SidebarRelativeTime({ value, className }: { value: string | number | null | undefined; className?: string }) {
  const currentTime = useSyncExternalStore(subscribe, snapshot, snapshot);
  const date = value == null ? null : dayjs(value);
  if (!date?.isValid()) return null;
  return <time className={className} dateTime={date.toISOString()} title={`Last activity ${date.format("MMM D, YYYY h:mm A")}`}>
    {date.from(currentTime)}
  </time>;
}
