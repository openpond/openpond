import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalManagedMessageTarget, TaskInput } from "@openpond/contracts";
import { ApiRequestError, apiFetch, type ClientConnection } from "../../api/api-client";

type Attempt = { hash: string; idempotencyKey: string; expectedTargetRevision: string; expectedTurnId?: string };
export function usePonderLocalMessage(connection: ClientConnection, scopeId: string | null) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [target, setTarget] = useState<LocalManagedMessageTarget | null>(null);
  const [receipt, setReceipt] = useState<TaskInput | null>(null);
  const [changed, setChanged] = useState(false);
  const [mode, setMode] = useState<"followup" | "steer">("followup");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const current = useRef({ connection, sessionId, scopeId }); current.current = { connection, sessionId, scopeId };
  const inspected = useRef<LocalManagedMessageTarget | null>(null);
  const generation = useRef(0);
  const requestOrder = useRef(0);
  const attempts = useRef(new Map<string, Attempt>());
  const select = useCallback((id: string | null) => {
    generation.current += 1;
    inspected.current = null;
    current.current = { connection: current.current.connection, scopeId: current.current.scopeId, sessionId: id };
    setTarget(null); setReceipt(null); setChanged(false); setMode("followup"); setError(null);
    setSessionId(id);
  }, []);
  useEffect(() => { select(null); }, [connection, scopeId, select]);
  const refresh = useCallback(async (acceptNewRevision = false, signal?: AbortSignal) => {
    if (!sessionId) return;
    const order = ++requestOrder.current;
    const epoch = generation.current;
    const result = await apiFetch<LocalManagedMessageTarget>(connection, `/v1/sessions/${encodeURIComponent(sessionId)}/local-message-target`, { signal });
    if (signal?.aborted || epoch !== generation.current || order !== requestOrder.current || current.current.connection !== connection || current.current.scopeId !== scopeId || current.current.sessionId !== sessionId) return;
    const previous = inspected.current;
    const next = !previous || acceptNewRevision ? result
      : { ...previous, inbox: result.inbox, paused: result.paused, approvalBlocked: result.approvalBlocked };
    inspected.current = next;
    setChanged(Boolean(previous && !acceptNewRevision && previous.targetRevision !== result.targetRevision));
    setTarget(next);
    setReceipt(previous => previous ? result.inbox.inputs.find(item => item.id === previous.id) ?? previous : null);
    setError(null);
  }, [connection, scopeId, sessionId]);
  useEffect(() => {
    generation.current += 1;
    inspected.current = null;
    setTarget(null); setReceipt(null); setChanged(false); setMode("followup"); setError(null); setBusy(false);
    if (!sessionId) return;
    const controller = new AbortController();
    let refreshing = false;
    const update = async () => {
      if (refreshing) return; refreshing = true;
      try { await refresh(false, controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to inspect the local task."); }
      finally { refreshing = false; }
    };
    void update(); const timer = window.setInterval(() => void update(), 3_000);
    return () => { generation.current += 1; controller.abort(); window.clearInterval(timer); };
  }, [sessionId, refresh]);
  async function send(prompt: string) {
    if (!sessionId || !target || changed || !target.canSendFollowup || pending.current || !prompt.trim()) return false;
    if (mode === "steer" && !target.canSteer) { setError("This turn is not accepting corrections. Queue a follow-up instead."); return false; }
    pending.current = true; setBusy(true);
    const epoch = generation.current;
    const stillCurrent = () => epoch === generation.current && current.current.connection === connection && current.current.scopeId === scopeId && current.current.sessionId === sessionId;
    let attemptKey: string | null = null;
    try {
      // A fingerprint scopes retry identity to the authenticated local connection without storing credentials.
      const scopeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([connection.serverUrl, connection.token, scopeId])));
      const scope = [...new Uint8Array(scopeDigest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([mode, prompt.trim()])));
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!stillCurrent()) return false;
      const key = `openpond:local-message-attempt:${scope}:${sessionId}:${hash}`;
      attemptKey = key;
      let attempt: Attempt = { hash, idempotencyKey: crypto.randomUUID(), expectedTargetRevision: target.targetRevision,
        ...(mode === "steer" && target.activeTurnId ? { expectedTurnId: target.activeTurnId } : {}) };
      const memoryAttempt = attempts.current.get(key);
      if (memoryAttempt?.hash === hash) attempt = memoryAttempt;
      try {
        const previous = JSON.parse(localStorage.getItem(key) ?? "null") as Attempt | null;
        if (previous?.hash === hash && typeof previous.idempotencyKey === "string" && typeof previous.expectedTargetRevision === "string") attempt = previous;
        localStorage.setItem(key, JSON.stringify(attempt));
      } catch { /* Mounted actions remain serialized; the canonical inbox owns receipts. */ }
      attempts.current.set(key, attempt);
      const value = await apiFetch<TaskInput>(connection, `/v1/sessions/${encodeURIComponent(sessionId)}/local-messages`, {
        method: "POST", body: JSON.stringify({ authority: "user_click", mode, prompt: prompt.trim(), idempotencyKey: attempt.idempotencyKey,
          expectedTargetRevision: attempt.expectedTargetRevision, ...(attempt.expectedTurnId ? { expectedTurnId: attempt.expectedTurnId } : {}) }),
      });
      attempts.current.delete(key);
      try { localStorage.removeItem(key); } catch { /* Optional draft identity cache. */ }
      if (!stillCurrent()) return false;
      setReceipt(value); setError(null);
      return true;
    } catch (cause) {
      if (attemptKey && cause instanceof ApiRequestError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) {
        // Definitive rejection admits no input. A reviewed new click can use its new revision.
        attempts.current.delete(attemptKey);
        try { localStorage.removeItem(attemptKey); } catch { /* Optional identity cache. */ }
      }
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : "Local message was not acknowledged."); return false; }
    finally { pending.current = false; if (stillCurrent()) setBusy(false); }
  }
  const reviewTarget = async () => {
    const epoch = generation.current;
    try { await refresh(true); }
    catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : "Unable to inspect the local task."); }
  };
  return { sessionId, select, target, mode, setMode, changed, receipt, error, busy, refresh: reviewTarget, send };
}
