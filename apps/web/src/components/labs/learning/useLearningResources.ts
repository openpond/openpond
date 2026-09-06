import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpenPondLearningClient, type LearningCommand, type LearningResourceFor, type LearningResourceKind, type LearningResourcePage, type LearningResourceQuery } from "openpond-sdk/learning";
import type { ClientConnection } from "../../../api";
import type { LearningRevisionRef, TaskEvidenceInspectionResult } from "openpond-sdk/learning";

export function useLearningInspection(client: OpenPondLearningClient | null, evidence: LearningRevisionRef) {
  const { id, revision, contentHash } = evidence;
  const key = `${id}:${revision}:${contentHash}`;
  const [state, setState] = useState<{ client: OpenPondLearningClient | null; key: string; result: TaskEvidenceInspectionResult | null; error: string | null } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    async function read() {
      try {
        if (!client) throw new Error("Connect to OpenPond to validate this example.");
        const result = await client.inspectEvidence({ id, revision, contentHash }, { signal: abort.signal });
        if (!abort.signal.aborted) setState({ client, key, result, error: null });
      } catch (error) {
        if (!abort.signal.aborted) setState({ client, key, result: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    void read();
    return () => abort.abort();
  }, [client, id, revision, contentHash, key]);
  const current = state?.client === client && state?.key === key ? state : null;
  return { inspection: current?.result?.inspection ?? null, error: current?.error ?? null };
}

export function useLearningClient(connection: ClientConnection | null, scope: string) {
  return useMemo(() => connection ? new OpenPondLearningClient({ baseUrl: connection.serverUrl, apiKey: connection.token, scope }) : null, [connection, scope]);
}

export function useLearningResources<K extends LearningResourceKind>(client: OpenPondLearningClient | null, kind: K, query: Partial<LearningResourceQuery> = {}, poll = false) {
  const [state, setState] = useState<{ client: OpenPondLearningClient | null; key: string; page: LearningResourcePage<K> | null; error: string | null; loading: boolean }>({ client: null, key: "", page: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const queryKey = JSON.stringify(query);
  const key = `${kind}:${queryKey}`;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((previous) => ({ client, key, page: previous.client === client && previous.key === key ? previous.page : null, error: null, loading: true }));
    async function read() {
      try {
        if (!client) throw new Error("Connect to OpenPond to load learning resources.");
        const page = await client.list(kind, JSON.parse(queryKey) as Partial<LearningResourceQuery>, { signal: abort.signal });
        if (!abort.signal.aborted) setState({ client, key, page, error: null, loading: false });
      } catch (error) {
        if (!abort.signal.aborted) setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error), loading: false }));
      }
      if (poll && !abort.signal.aborted) timer = setTimeout(() => { void read(); }, 2_000);
    }
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [client, kind, queryKey, key, revision, poll]);
  const current = state.client === client && state.key === key;
  return { page: current ? state.page : null, error: current ? state.error : null, loading: !current || state.loading, refresh: useCallback(() => setRevision((value) => value + 1), []) };
}

export function useLearningMutation(client: OpenPondLearningClient | null) {
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
      return await action(client);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return null; }
    finally { active.current = false; setBusy(false); }
  }
  return { busy, error, run, command: (command: LearningCommand) => run((api) => api.command(command)) };
}

export function useLearningResource<K extends LearningResourceKind>(client: OpenPondLearningClient | null, kind: K, id: string | null, revision?: number, poll = false) {
  const [state, setState] = useState<{ client: OpenPondLearningClient | null; key: string; resource: LearningResourceFor<K> | null; error: string | null }>({ client: null, key: "", resource: null, error: null });
  const [generation, setGeneration] = useState(0);
  const key = `${kind}:${id}:${revision ?? "latest"}`;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        if (!client) throw new Error("Connect to OpenPond to load this resource.");
        if (!id) return;
        const resource = await client.get(kind, id, revision, { signal: abort.signal });
        if (!abort.signal.aborted) setState({ client, key, resource, error: null });
      } catch (error) {
        if (!abort.signal.aborted) setState({ client, key, resource: null, error: error instanceof Error ? error.message : String(error) });
      }
      if (poll && id && !abort.signal.aborted) timer = setTimeout(() => { void read(); }, 2_000);
    }
    if (id) void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [client, kind, id, revision, key, generation, poll]);
  const current = state.client === client && state.key === key && id !== null;
  return { resource: current ? state.resource : null, error: current ? state.error : null, refresh: useCallback(() => setGeneration((value) => value + 1), []) };
}

export function learningOperationId() { return crypto.randomUUID(); }
