import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import type { PonderRecommendation } from "./ponder-recommendations";

export function usePonderRecommendations(connection: ClientConnection, bindingId: string | null) {
  const [items, setItems] = useState<PonderRecommendation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const current = useRef({ connection, bindingId });
  current.current = { connection, bindingId };
  const pending = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!bindingId) return;
    const result = await apiFetch<{ bindingId: string; items: PonderRecommendation[] }>(connection, "/v1/ponder/recommendations", { signal });
    if (mounted.current && !signal?.aborted && current.current.connection === connection && current.current.bindingId === bindingId && result.bindingId === bindingId) {
      setItems(result.items);
      setError(null);
    }
  }, [connection, bindingId]);
  useEffect(() => {
    mounted.current = true;
    setItems([]); setError(null); setBusy(null);
    if (!bindingId) return () => { mounted.current = false; };
    const controller = new AbortController();
    let refreshing = false;
    const update = async () => {
      if (refreshing) return;
      refreshing = true;
      try { await refresh(controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to read recommendations."); }
      finally { refreshing = false; }
    };
    void update();
    const timer = window.setInterval(() => void update(), 5_000);
    return () => { mounted.current = false; controller.abort(); window.clearInterval(timer); };
  }, [bindingId, refresh]);

  const action = useCallback(async (item: PonderRecommendation, action: "send" | "dismiss" | "read", message?: string) => {
    if (pending.current || !bindingId) return false;
    const retry = action === "send" && (item.state === "submitting" || item.state === "failed");
    if (retry && (!item.submittedText || item.submissionRevision === null)) return false;
    const expectedRevision = retry ? item.submissionRevision : item.revision;
    const submitted = retry ? item.submittedText : message;
    pending.current = true; setBusy(item.id);
    try {
      await apiFetch(connection, `/v1/ponder/recommendations/${encodeURIComponent(item.id)}/action`, {
        method: "POST", body: JSON.stringify({ action, expectedRevision, ...(submitted === undefined ? {} : { message: submitted }) }),
      });
      if (!mounted.current || current.current.connection !== connection || current.current.bindingId !== bindingId) return false;
      await refresh();
      return mounted.current && current.current.connection === connection && current.current.bindingId === bindingId;
    } catch (cause) {
      if (current.current.connection === connection && current.current.bindingId === bindingId) setError(cause instanceof Error ? cause.message : "Recommendation action failed.");
      return false;
    } finally { pending.current = false; if (current.current.connection === connection && current.current.bindingId === bindingId) setBusy(null); }
  }, [bindingId, connection, refresh]);
  return { items, error, busy, action, refresh };
}
