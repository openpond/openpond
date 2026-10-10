import type { AppToast } from "./app-toasts";

export const TOAST_LIFETIME_MS = 5_000;
export const TOAST_ENTER_MS = 300;
export const TOAST_EXIT_MS = 160;
export type ToastPresentation = { toast: AppToast; phase: "entering" | "visible" | "exiting"; parked: boolean };
type Entry = ToastPresentation & {
  remaining: number;
  entered: boolean;
  deadline: number | null;
  paused: boolean;
};

/** Visible time belongs to an ID, never to its position in the stack. */
export class ToastLifecycle {
  private entries = new Map<number, Entry>();
  private order: number[] = [];
  private capacity = 3;

  sync(toasts: readonly AppToast[], now: number): void {
    const ids = new Set(toasts.map(toast => toast.id));
    for (const entry of this.entries.values()) {
      if (!ids.has(entry.toast.id)) this.dismiss(entry.toast.id, now);
    }
    for (const toast of toasts) {
      const existing = this.entries.get(toast.id);
      if (existing) existing.toast = toast;
      else this.entries.set(toast.id, { toast, phase: "entering", parked: true, remaining: TOAST_LIFETIME_MS,
        entered: false, deadline: null, paused: false });
    }
    this.order = [...toasts.map(toast => toast.id), ...this.order.filter(id => !ids.has(id) && this.entries.has(id))];
    this.reflow(now);
  }

  setCapacity(capacity: number, now: number): void {
    this.capacity = Math.max(1, Math.min(3, capacity));
    this.reflow(now);
  }

  pause(id: number, paused: boolean, now: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.paused === paused) return;
    if (paused) this.stopClock(entry, now);
    entry.paused = paused;
    this.reflow(now);
  }

  dismiss(id: number, now: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.phase === "exiting") return;
    if (entry.parked) { this.entries.delete(id); return; }
    entry.phase = "exiting";
    entry.deadline = now + TOAST_EXIT_MS;
    entry.paused = false;
  }

  tick(now: number): number[] {
    const expired: number[] = [];
    for (const [id, entry] of this.entries) {
      const retention = entry.toast.kind === "attention" ? 120_000 : 60_000;
      if (entry.parked && now >= entry.toast.createdAt + retention) {
        this.entries.delete(id); expired.push(id); continue;
      }
      if (entry.deadline === null || now < entry.deadline) continue;
      if (entry.phase === "exiting") { this.entries.delete(id); continue; }
      if (entry.phase === "entering") {
        entry.phase = "visible"; entry.entered = true; entry.deadline = null;
      } else {
        expired.push(id); this.dismiss(id, now);
      }
    }
    this.reflow(now);
    return expired;
  }

  snapshot(): ToastPresentation[] {
    return this.order.flatMap(id => {
      const entry = this.entries.get(id);
      return entry ? [{ toast: entry.toast, phase: entry.phase, parked: entry.parked }] : [];
    });
  }

  nextDeadline(): number | null {
    const deadlines = [...this.entries.values()].flatMap(entry => entry.deadline !== null ? [entry.deadline]
      : entry.parked ? [entry.toast.createdAt + (entry.toast.kind === "attention" ? 120_000 : 60_000)] : []);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  private stopClock(entry: Entry, now: number): void {
    if (entry.phase === "visible" && entry.deadline !== null) entry.remaining = Math.max(0, entry.deadline - now);
    entry.deadline = null;
  }

  private reflow(now: number): void {
    const active = this.order.flatMap(id => {
      const entry = this.entries.get(id);
      return entry && entry.phase !== "exiting" ? [entry] : [];
    });
    // While a card is being used, defer any arrival that would hide it.
    let protectedIndex = -1;
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index]!.paused && !active[index]!.parked) { protectedIndex = index; break; }
    }
    const start = Math.max(0, protectedIndex - this.capacity + 1);
    const visible = new Set(active.slice(start, start + this.capacity).map(entry => entry.toast.id));
    for (const entry of active) {
      const parked = !visible.has(entry.toast.id);
      if (parked && !entry.parked) this.stopClock(entry, now);
      entry.parked = parked;
      if (parked || entry.paused || entry.deadline !== null) continue;
      if (!entry.entered) {
        entry.phase = "entering"; entry.deadline = now + TOAST_ENTER_MS;
      } else {
        entry.phase = "visible"; entry.deadline = now + entry.remaining;
      }
    }
  }
}
