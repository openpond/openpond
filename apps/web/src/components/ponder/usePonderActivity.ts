import { useEffect, useRef } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import type { PonderNotification } from "./ponder-recommendations";

/** Notifications use hosted identity/read state; this hook never sends task inputs. */
export function usePonderActivity(connection: ClientConnection | null, accountScope: string | null, onOpenPonder?: () => void) {
  const open = useRef(onOpenPonder);
  open.current = onOpenPonder;
  useEffect(() => {
    if (!connection || !accountScope) return;
    let closed = false;
    let refreshing = false;
    let binding: string | null = null;
    const delivered = new Set<string>();
    const browserNotifications = new Map<string, Notification>();
    const storageKey = (bindingId: string) => `openpond:ponder-notification-delivery:${accountScope}:${bindingId}`;
    async function clicked(id: string) {
      if (closed || !binding) return;
      try {
        const page = await apiFetch<{ bindingId: string; items: PonderNotification[] }>(connection!, "/v1/ponder/notifications");
        if (closed || page.bindingId !== binding || !page.items.some(item => item.id === id)) return;
        await apiFetch(connection!, `/v1/ponder/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" });
        if (closed) return;
        window.focus(); open.current?.();
      } catch { /* A revoked or unavailable account cannot open a stale action. */ }
    }
    const unsubscribe = window.openpond?.onPonderNotification?.(payload => { void clicked(payload.id); });
    async function refresh() {
      if (closed || refreshing) return;
      refreshing = true;
      try {
        const [settings, page] = await Promise.all([
          apiFetch<{ bindingId: string; settings: { notifications: string } }>(connection!, "/v1/ponder/settings"),
          apiFetch<{ bindingId: string; items: PonderNotification[] }>(connection!, "/v1/ponder/notifications"),
        ]);
        if (closed || settings.bindingId !== page.bindingId) return;
        if (binding !== page.bindingId) {
          binding = page.bindingId; delivered.clear();
          try {
            const prior: unknown = JSON.parse(localStorage.getItem(storageKey(binding)) ?? "[]");
            if (Array.isArray(prior)) for (const id of prior) if (typeof id === "string") delivered.add(id);
          } catch { /* Optional client delivery cache. Shared read state remains hosted. */ }
        }
        const unread = new Set(page.items.filter(item => !item.readAt).map(item => item.id));
        for (const [id, notification] of browserNotifications) {
          if (!unread.has(id)) { notification.close(); browserNotifications.delete(id); }
        }
        if (localStorage.getItem("openpond:ponder-notifications") !== "on" || settings.settings.notifications === "off") return;
        for (const item of page.items) {
          if (closed || item.readAt || delivered.has(item.id)) continue;
          const payload = { id: item.id, title: item.title.slice(0, 160), body: item.body.slice(0, 500), ponder: true };
          let accepted = false;
          if (window.openpond?.notify) accepted = await window.openpond.notify(payload);
          else if ("Notification" in window && Notification.permission === "granted") {
            const notification = new Notification(payload.title, { body: payload.body, tag: payload.id });
            notification.onclick = () => { notification.close(); void clicked(item.id); };
            browserNotifications.set(item.id, notification); accepted = true;
          }
          if (closed) return;
          if (accepted) delivered.add(item.id);
        }
        while (delivered.size > 500) delivered.delete(delivered.values().next().value!);
        try { localStorage.setItem(storageKey(binding), JSON.stringify([...delivered])); }
        catch { /* This mounted client still deduplicates delivery. */ }
      } catch { /* Durable hosted notifications remain available for the next poll. */ }
      finally { refreshing = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    const refreshSettings = () => { void refresh(); };
    window.addEventListener("ponder-settings-changed", refreshSettings);
    return () => {
      closed = true; window.clearInterval(timer); unsubscribe?.();
      window.removeEventListener("ponder-settings-changed", refreshSettings);
      for (const notification of browserNotifications.values()) notification.close();
    };
  }, [connection, accountScope]);
}
