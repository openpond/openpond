import { useEffect } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type Activity = {
  id: string;
  source: string;
  kind: string;
  resourceId: string;
  title: string;
  status: string;
  occurredAt: string;
  sequence: number;
};
export function usePonderActivity(
  connection: ClientConnection | null,
  accountScope: string | null,
) {
  useEffect(() => {
    if (!connection || !accountScope) return;
    let closed = false;
    let inFlight = false;
    let binding: string | null = null;
    let after = 0;
    const startedAt = Date.now();
    async function refresh() {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const settings = await apiFetch<{ bindingId: string; settings: { notifications: string } }>(
          connection!,
          "/v1/ponder/settings",
        );
        if (closed) return;
        const cursorKey = `openpond:ponder-activity:${accountScope}:${settings.bindingId}`;
        if (binding !== settings.bindingId) {
          binding = settings.bindingId;
          try {
            after = Number(localStorage.getItem(cursorKey) ?? "0");
          } catch {
            after = 0;
          }
          if (!Number.isSafeInteger(after) || after < 0) after = 0;
        }
        let hasMore = true;
        while (hasMore && !closed) {
          const page = await apiFetch<{
            bindingId: string;
            items: Activity[];
            nextCursor: number;
            hasMore: boolean;
          }>(connection!, `/v1/ponder/activity?after=${after}`);
          if (closed || page.bindingId !== binding) return;
          for (const item of page.items) {
            const attention = [
              "completed",
              "failed",
              "cancelled",
              "waiting_input",
              "waiting_approval",
              "interrupted",
            ].includes(item.status);
            const eligible =
              settings.settings.notifications === "all" ||
              (settings.settings.notifications === "attention" && attention);
            if (
              !eligible ||
              Date.parse(item.occurredAt) < startedAt ||
              localStorage.getItem("openpond:ponder-notifications") !== "on"
            )
              continue;
            const payload = {
              id: item.id,
              title: "Ponder Pal",
              body: `${item.title}: ${item.status.replaceAll("_", " ")}`.slice(0, 500),
            };
            if (window.openpond?.notify) await window.openpond.notify(payload);
            else if ("Notification" in window && Notification.permission === "granted") {
              const notification = new Notification(payload.title, {
                body: payload.body,
                tag: payload.id,
              });
              notification.onclick = () => window.focus();
            }
          }
          after = page.nextCursor;
          try {
            localStorage.setItem(cursorKey, String(after));
          } catch {
            /* The active session still retains its cursor. */
          }
          hasMore = page.hasMore;
        }
      } catch {
        /* Retry on the next poll; the server keeps undelivered activity. */
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener("ponder-settings-changed", refresh);
    return () => {
      closed = true;
      window.clearInterval(timer);
      window.removeEventListener("ponder-settings-changed", refresh);
    };
  }, [connection, accountScope]);
}
