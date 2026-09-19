import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OpenPondLearningClient, type LearningCommand, type LearningResourceKind, type LearningResourceQuery, type LearningRevisionRef } from "openpond-sdk/learning";
import type { ClientConnection } from "../../../api";
import { connectionQueryScope, learningQueryScope, scopeLearningClient } from "../../../lib/query-scope";

export function useLearningInspection(client: OpenPondLearningClient | null, evidence: LearningRevisionRef) {
  const result = useQuery({ queryKey: [...learningQueryScope(client), "inspection", evidence], enabled: Boolean(client),
    queryFn: ({ signal }) => client!.inspectEvidence(evidence, { signal }) });
  return { inspection: result.data?.inspection ?? null, error: result.error?.message ?? null };
}

export function useLearningClient(connection: ClientConnection | null, scope: string) {
  return useMemo(() => connection ? scopeLearningClient(new OpenPondLearningClient({ baseUrl: connection.serverUrl, apiKey: connection.token, scope }),
    ["learning", connectionQueryScope(connection), scope]) : null, [connection, scope]);
}

export function useLearningResources<K extends LearningResourceKind>(client: OpenPondLearningClient | null, kind: K, query: Partial<LearningResourceQuery> = {}, poll = false) {
  const result = useQuery({ queryKey: [...learningQueryScope(client), "list", kind, query], enabled: Boolean(client),
    queryFn: ({ signal }) => client!.list(kind, query, { signal }), refetchInterval: current => poll && (kind !== "grade" || !current.state.data || current.state.data.items.some(entry => "status" in entry && ["queued", "running", "cancelling"].includes(String(entry.status)))) ? (kind === "grade" ? 2_000 : 10_000) : false });
  const refresh = useCallback(() => { void result.refetch(); }, [result.refetch]);
  return { page: result.data ?? null, error: result.error?.message ?? null, loading: Boolean(client) && result.isPending, refresh };
}

export function useLearningMutation(client: OpenPondLearningClient | null) {
  const queries = useQueryClient();
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: (client: OpenPondLearningClient) => Promise<T>): Promise<T | null> {
    if (active.current) return null;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!client) throw new Error("Connect to OpenPond before saving.");
      const result = await action(client);
      await queries.invalidateQueries({ queryKey: learningQueryScope(client) });
      return result;
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return null; }
    finally { active.current = false; setBusy(false); }
  }
  return { busy, error, run, command: (command: LearningCommand) => run((api) => api.command(command)) };
}

export function useLearningResource<K extends LearningResourceKind>(client: OpenPondLearningClient | null, kind: K, id: string | null, revision?: number, poll = false) {
  const result = useQuery({ queryKey: [...learningQueryScope(client), "resource", kind, id, revision ?? "latest"], enabled: Boolean(client && id),
    queryFn: ({ signal }) => client!.get(kind, id!, revision, { signal }), refetchInterval: current => poll && (kind !== "grade" || !current.state.data || ("status" in current.state.data && ["queued", "running", "cancelling"].includes(String(current.state.data.status)))) ? (kind === "grade" ? 2_000 : 10_000) : false });
  const refresh = useCallback(() => { void result.refetch(); }, [result.refetch]);
  return { resource: result.data ?? null, error: result.error?.message ?? null, refresh };
}

export function learningOperationId() { return crypto.randomUUID(); }

/** Reusable catalogs are searched as a whole; attempts keep their paginated query. */
export function useLearningCatalog<K extends LearningResourceKind>(client: OpenPondLearningClient | null, kind: K, query: Partial<LearningResourceQuery> = {}) {
  const result = useQuery({
    queryKey: [...learningQueryScope(client), kind, "catalog", query],
    enabled: Boolean(client),
    queryFn: async ({ signal }) => {
      const first = await client!.list(kind, { ...query, limit: 100 }, { signal });
      const items = [...first.items];
      let afterId = first.nextCursor;
      const seen = new Set<string>();
      while (afterId) {
        if (seen.has(afterId)) throw new Error("Unable to load the complete catalog: pagination did not advance.");
        seen.add(afterId);
        const page = await client!.list(kind, { ...query, limit: 100, afterId }, { signal });
        items.push(...page.items);
        afterId = page.nextCursor;
      }
      return items;
    },
  });
  return { items: result.data ?? [], loading: result.isLoading, error: result.error?.message ?? null, refresh: () => { void result.refetch(); } };
}
