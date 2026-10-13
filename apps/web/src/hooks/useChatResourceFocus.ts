import { useEffect, useRef, useState } from "react";
import type { ChatExperimentContext, ChatResourceSummary } from "@openpond/contracts";
import type { ClientConnection } from "../api/api-client";
import { chatResourceRequest } from "../api/chat-resource-api";

export type ChatResourceFocus = { dataset: ChatResourceSummary | null; experiment: ChatResourceSummary | null; scopeContext?: ChatExperimentContext };
type ContextResponse = { focus: ChatResourceFocus; datasets: ChatResourceSummary[]; experiments: ChatResourceSummary[]; graders: ChatResourceSummary[] };
const emptyFocus = (): ChatResourceFocus => ({ dataset: null, experiment: null });

export function useChatResourceFocus(connection: ClientConnection | null, sessionId: string | null) {
  const [focus, setFocus] = useState<ChatResourceFocus>(emptyFocus);
  const [datasets, setDatasets] = useState<ChatResourceSummary[]>([]);
  const [experiments, setExperiments] = useState<ChatResourceSummary[]>([]);
  const [graders, setGraders] = useState<ChatResourceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const generation = useRef(0), selection = useRef<AbortController | null>(null);
  const focusRef = useRef(focus); focusRef.current = focus;
  const reload = useRef<(() => void) | null>(null);

  useEffect(() => {
    generation.current++; selection.current?.abort(); selection.current = null;
    setDatasets([]); setExperiments([]); setGraders([]); setSelecting(false);
    setFocus(emptyFocus()); setError(null);
    if (!connection || !sessionId) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    let loading = false, again = false;
    const load = async () => {
      if (loading) { again = true; return; }
      loading = true; clearTimeout(timer);
      const admitted = generation.current;
      try {
        const response = await chatResourceRequest<ContextResponse>(connection, "dataset", { action: "context", payload: { sessionId } }, abort.signal);
        if (!abort.signal.aborted && admitted === generation.current) {
          setFocus(response.focus); setDatasets(response.datasets); setExperiments(response.experiments); setGraders(response.graders); setError(null);
        }
      } catch (cause) { if (!abort.signal.aborted && admitted === generation.current) setError(cause instanceof Error ? cause.message : "Resource context unavailable."); }
      loading = false;
      if (!abort.signal.aborted) {
        if (again) { again = false; void load(); }
        else timer = setTimeout(() => void load(), 10_000);
      }
    };
    reload.current = () => void load();
    const changed=(event:Event)=>{if((event as CustomEvent<{sessionId:string}>).detail?.sessionId===sessionId)void load();};
    window.addEventListener("openpond-resource-focus-changed",changed);
    void load();
    return () => { window.removeEventListener("openpond-resource-focus-changed",changed); reload.current = null; generation.current++; selection.current?.abort(); abort.abort(); clearTimeout(timer); };
  }, [connection, sessionId]);

  async function change(action: string, payload: Record<string, unknown>) {
    if (!connection || !sessionId || selection.current) return false;
    const admitted = ++generation.current;
    const abort = new AbortController(); selection.current = abort; setSelecting(true);
    try {
      const next = await chatResourceRequest<ChatResourceFocus>(connection, "dataset", { action, payload: {
        sessionId, ...payload,
        ...(focusRef.current.scopeContext ? { expectedSelectionVersion: focusRef.current.scopeContext.selectionVersion } : {}),
      } }, abort.signal);
      if (admitted === generation.current && !abort.signal.aborted) { setFocus(next); focusRef.current = next;
        setGraders(next.scopeContext?.scopes.find(scope=>scope.id===next.scopeContext?.activeScopeId)?.graders ?? []); setError(null); }
      return !abort.signal.aborted;
    } catch (cause) {
      if (admitted === generation.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Resource selection failed.");
      return false;
    } finally {
      if (selection.current === abort) { selection.current = null; setSelecting(false); reload.current?.(); }
    }
  }
  const scope = focus.scopeContext?.scopes.find(candidate => candidate.id === focus.scopeContext?.activeScopeId) ?? null;
  return { focus, scope, datasets, experiments, graders, selecting, error,
    select: (kind: "dataset" | "experiment" | "grader", id: string, revision?: number) => change("set_focus", { kind, id: id || null, ...(revision ? { revision } : {}) }),
    selectScope: (scopeId: string) => change("select_scope", { scopeId }),
    createScope: () => change("create_scope", { operationId: `scope-${crypto.randomUUID()}` }),
    renameScope: (scopeId: string, name: string) => change("rename_scope", { scopeId, name }),
  };
}
