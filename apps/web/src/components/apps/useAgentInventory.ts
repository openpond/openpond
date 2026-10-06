import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import type { AgentInventory } from "./agent-connections";

const inventories = new WeakMap<ClientConnection, AgentInventory>();
export function useAgentInventory(connection: ClientConnection | null) {
  const [state, setState] = useState<{
    connection: ClientConnection;
    value: AgentInventory;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!connection || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const ownGeneration = generation.current;
    setLoading(true);
    try {
      const value = await apiFetch<AgentInventory>(
        connection,
        "/v1/native-history/collector",
        {
          method: "POST",
          body: JSON.stringify({ command: "inventory" }),
          signal: controller.signal,
        },
      );
      if (ownGeneration !== generation.current || controller.signal.aborted)
        return;
      inventories.set(connection, value);
      setState({ connection, value });
      setError(null);
    } catch (failure) {
      if (ownGeneration === generation.current && !controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Unable to read agent connections.",
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (ownGeneration === generation.current) setLoading(false);
    }
  }, [connection]);
  useEffect(() => {
    generation.current++;
    setError(null);
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      generation.current++;
      pending.current?.abort();
      pending.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  return {
    inventory:
      state?.connection === connection
        ? state.value
        : connection
          ? (inventories.get(connection) ?? null)
          : null,
    loading,
    error,
    refresh,
  };
}
