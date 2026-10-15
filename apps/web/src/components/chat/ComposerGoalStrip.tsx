import "./composer-goal.css";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Pause, Play, Pencil, Target } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";
import type { ClientConnection } from "../../api";
import { sessionApi } from "../../api/session-api";
import { goalRuntimeFromRecord, projectGoalRuntimeTo, type GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import { useGoalRuntimeClock } from "../../hooks/useGoalRuntimeClock";

export function ComposerGoalStrip({
  detailsOpen, goalRuntime, objectiveId, subagentRuntime, onToggleDetails,
  connection, sessionId, running, onPause, onResume,
}: {
  detailsOpen: boolean;
  goalRuntime: GoalRuntimeStatus | null;
  objectiveId: string;
  subagentRuntime?: SubagentRuntimeStatus | null;
  onToggleDetails: () => void;
  connection: ClientConnection | null;
  sessionId: string | null;
  running: boolean;
  onPause: () => Promise<boolean | void>;
  onResume: () => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<{ original: string; draft: string } | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<{ source: string; runtime: GoalRuntimeStatus | null } | null>(null);
  const locked = useRef(false);
  const revision = useRef(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Only bridge the gap until the provider's updated history/event arrives.
  const source = JSON.stringify([goalRuntime?.objective, goalRuntime?.status, goalRuntime?.tokensUsed, goalRuntime?.tokenBudget]);
  const observedAt = useGoalRuntimeClock((saved?.source === source ? saved.runtime : goalRuntime)?.tone === "active");
  const resolved = saved?.source === source
    ? projectGoalRuntimeTo(saved.runtime, observedAt)
    : goalRuntime;
  const runtime = resolved ?? goalRuntime;
  const editable = Boolean(connection && sessionId);
  useErrorToast(error, { prefix: "Goal" });

  useEffect(() => {
    if (!connection || !sessionId) return;
    let cancelled = false;
    const expectedRevision = revision.current;
    void sessionApi.getGoal(connection, sessionId).then(result => {
      if (!cancelled && !locked.current && revision.current === expectedRevision) setSaved({ source, runtime: result.goal ? goalRuntimeFromRecord(result.goal, result.observedAt) : null });
    }).catch(cause => { if (!cancelled) setError(cause); });
    return () => { cancelled = true; };
  }, [connection, sessionId, source, running]);

  async function openEditor() {
    if (!connection || !sessionId || locked.current) return;
    revision.current++;
    locked.current = true;
    setOperation("load");
    setError(null);
    try {
      const result = await sessionApi.getGoal(connection, sessionId);
      const next = result.goal ? goalRuntimeFromRecord(result.goal, result.observedAt) : null;
      setSaved({ source, runtime: next });
      if (next) setEdit({ original: next.objective, draft: next.objective });
    } catch (cause) { setError(cause); }
    finally { locked.current = false; setOperation(null); }
  }

  function closeEditor() {
    setEdit(null);
    toggleRef.current?.focus();
  }

  async function update(kind: "save" | "pause" | "resume") {
    if (!connection || !sessionId || locked.current || !runtime) return;
    const objective = edit?.draft.trim();
    if (kind === "save" && !objective) return;
    const operationRevision = ++revision.current;
    locked.current = true;
    setOperation(kind);
    setError(null);
    try {
      const result = await sessionApi.patchGoal(connection, sessionId, {
        expectedObjective: kind === "save" ? edit!.original : runtime.objective,
        ...(kind === "save" ? { objective } : { status: kind === "pause" ? "paused" as const : "active" as const }),
      });
      const next = goalRuntimeFromRecord(result.goal, result.observedAt);
      if (next) setSaved({ source, runtime: next });
      if (kind === "save") closeEditor();
      if (kind === "pause" && running) await onPause();
      if (kind === "resume" && !running) {
        // Imported-history submission can await the whole turn. Keep Pause usable
        // during that turn and never roll back a newer user action.
        void onResume().catch(cause => {
          setError(cause);
          return false;
        }).then(async started => {
          if (started || revision.current !== operationRevision) return;
          const paused = await sessionApi.patchGoal(connection, sessionId, { expectedObjective: runtime.objective, status: "paused" });
          const restored = goalRuntimeFromRecord(paused.goal, paused.observedAt);
          if (restored && revision.current === operationRevision) setSaved({ source, runtime: restored });
        }).catch(cause => setError(cause));
      }
    } catch (cause) {
      setError(cause);
    } finally {
      locked.current = false;
      setOperation(null);
    }
  }

  if (!resolved || !runtime) return null;
  return (
    <section className={`composer-goal-strip ${runtime.tone}`} aria-label="Goal" aria-busy={Boolean(operation)}>
      <div className="composer-goal-heading">
        <button ref={toggleRef} type="button" className="composer-goal-toggle"
          aria-label={`${detailsOpen ? "Hide" : "Show"} goal details`}
          aria-expanded={detailsOpen || Boolean(edit)} aria-controls={objectiveId}
          onClick={() => { if (!edit) onToggleDetails(); }} title={runtime.objective}>
          <Target size={15} aria-hidden="true" />
          <span className="composer-goal-status">{runtime.actionLabel}</span>
          <span className="composer-goal-preview">{runtime.objective}</span>
        </button>
        <span className="composer-goal-time" title={runtime.tooltip}>{runtime.timeLabel}</span>
        {editable ? <div className="composer-goal-actions">
          <button type="button" aria-label="Edit goal" title="Edit goal" disabled={Boolean(operation) || Boolean(edit)}
            onClick={() => void openEditor()}><Pencil size={15} /></button>
          {runtime.tone === "active" || runtime.tone === "paused" ? <button type="button"
            aria-label={runtime.tone === "active" ? "Pause goal" : "Resume goal"}
            title={runtime.tone === "active" ? "Pause goal" : "Resume goal"}
            disabled={Boolean(operation) || Boolean(edit)}
            onClick={() => void update(runtime.tone === "active" ? "pause" : "resume")}>
            {runtime.tone === "active" ? <Pause size={15} /> : <Play size={15} />}
          </button> : null}
        </div> : null}
        <button type="button" className="composer-goal-disclosure" aria-label="Toggle goal details"
          aria-expanded={detailsOpen || Boolean(edit)} aria-controls={objectiveId} disabled={Boolean(edit)} onClick={onToggleDetails}>
          <ChevronDown size={15} />
        </button>
      </div>
      {edit || detailsOpen ? <div className="composer-goal-objective" id={objectiveId}>
        {edit ? <div className="composer-goal-editor">
          <label htmlFor={`${objectiveId}-input`}>Goal objective</label>
          <textarea id={`${objectiveId}-input`} autoFocus rows={3} maxLength={32_000} value={edit.draft}
            disabled={Boolean(operation)} onChange={event => setEdit({ ...edit, draft: event.target.value })}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === "Escape" && !operation) { event.preventDefault(); closeEditor(); }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void update("save"); }
            }} />
          <div className="composer-goal-editor-actions">
            <button type="button" disabled={Boolean(operation)} onClick={closeEditor}>Cancel</button>
            <button type="button" className="composer-goal-save" disabled={Boolean(operation) || !edit.draft.trim() || edit.draft.trim() === edit.original}
              onClick={() => void update("save")}>{operation === "save" ? "Saving…" : "Save goal"}</button>
          </div>
        </div> : <p>{runtime.objective}</p>}
        <small>{runtime.detail}</small>
        {subagentRuntime ? <span className="composer-goal-subagent-summary">{subagentRuntime.tooltip}</span> : null}
      </div> : null}
    </section>
  );
}
