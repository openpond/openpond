import { useCallback, useEffect, useState } from "react";
import type {
  ChatWorkflow,
  ChatWorkflowRun,
  UpdateChatWorkflowRequest,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

const REFRESH_INTERVAL_MS = 30_000;

export function useChatWorkflows(connection: ClientConnection | null) {
  const [workflows, setWorkflows] = useState<ChatWorkflow[]>([]);
  const [runs, setRuns] = useState<ChatWorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (showLoading: boolean) => {
    if (!connection) return;
    if (showLoading) setLoading(true);
    try {
      const payload = await api.chatWorkflows(connection);
      setWorkflows(payload.workflows);
      setRuns(payload.runs);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!connection) {
      setWorkflows([]);
      setRuns([]);
      setError(null);
      setLoading(false);
      return;
    }
    void load(true);
    const interval = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [connection, load]);

  async function mutate(id: string, operation: () => Promise<unknown>) {
    if (pendingIds.has(id)) return;
    setPendingIds((current) => new Set(current).add(id));
    try {
      await operation();
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return {
    workflows,
    runs,
    loading,
    error,
    pendingIds,
    refresh: () => load(true),
    update: (id: string, input: UpdateChatWorkflowRequest) =>
      mutate(id, () => api.updateChatWorkflow(connection!, id, input)),
    remove: (id: string) =>
      mutate(id, () => api.deleteChatWorkflow(connection!, id)),
    run: (id: string) =>
      mutate(id, () => api.runChatWorkflow(connection!, id)),
  };
}
