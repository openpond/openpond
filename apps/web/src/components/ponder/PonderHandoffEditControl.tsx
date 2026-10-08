import { useEffect, useRef, useState } from "react";
import {
  PonderDesktopHandoffEditContextSchema,
  type PonderDesktopHandoffEditContext,
  type PonderDesktopHandoffPresentation,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { assertOriginalPonderDesktop } from "./ponder-local-work";

export function PonderHandoffEditControl({
  connection,
  item,
  onSaved,
}: {
  connection: ClientConnection;
  item: PonderDesktopHandoffPresentation;
  onSaved: () => Promise<void>;
}) {
  const [context, setContext] = useState<PonderDesktopHandoffEditContext | null>(null);
  const [targetId, setTargetId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [criteria, setCriteria] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    generation.current++;
    pending.current = false;
    keys.current.clear();
    setContext(null);
    setBusy(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [connection, item.id, item.revision]);

  async function load() {
    if (pending.current) return;
    const version = generation.current;
    pending.current = true;
    setBusy(true);
    try {
      await assertOriginalPonderDesktop(connection, item.scope);
      const path = `/v1/ponder/handoffs/${encodeURIComponent(item.id)}/edit`;
      const value = PonderDesktopHandoffEditContextSchema.parse(await apiFetch(connection, path));
      if (value.handoffId !== item.id || value.revision !== item.revision)
        throw new Error("The handoff changed. Refresh Activity before editing it.");
      const targets = [...value.targets];
      let cursor = value.nextCursor;
      let pages = 1;
      while (cursor) {
        if (version !== generation.current) return;
        if (++pages > 200) throw new Error("The desktop catalog exceeded its page limit.");
        const page = PonderDesktopHandoffEditContextSchema.parse(
          await apiFetch(
            connection,
            `${path}?cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
          ),
        );
        if (page.handoffId !== value.handoffId || page.revision !== value.revision)
          throw new Error("The handoff changed. Refresh Activity before editing it.");
        targets.push(...page.targets);
        cursor = page.nextCursor;
      }
      if (version !== generation.current) return;
      value.targets = targets;
      value.nextCursor = null;
      setContext(value);
      setTargetId(
        value.targets.some(
          (target) =>
            target.id === value.successor.targetId &&
            target.revision === value.successor.targetRevision,
        )
          ? value.successor.targetId
          : "",
      );
      setTitle(value.successor.action === "create" ? value.successor.title : item.title);
      setPrompt(value.successor.prompt);
      setCriteria(value.successCriteria);
      setError(null);
    } catch (cause) {
      if (version === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function save() {
    if (!context || pending.current) return;
    const target = context.targets.find((target) => target.id === targetId);
    if (!target) {
      setError("Choose an available successor on the original desktop.");
      return;
    }
    const successor = {
      ...context.successor,
      targetId: target.id,
      targetRevision: target.revision,
      prompt: prompt.trim(),
      ...(context.successor.action === "create" ? { title: title.trim() } : {}),
    };
    const payload = JSON.stringify({
      handoffId: item.id,
      expectedRevision: context.revision,
      successor,
      successCriteria: criteria.trim(),
    });
    if (!keys.current.has(payload)) keys.current.set(payload, crypto.randomUUID());
    const version = generation.current;
    pending.current = true;
    setBusy(true);
    try {
      await assertOriginalPonderDesktop(connection, item.scope);
      if (version !== generation.current) return;
      await apiFetch(connection, "/v1/ponder/handoffs/edit", {
        method: "POST",
        body: payload,
        headers: { "Idempotency-Key": keys.current.get(payload)! },
      });
      if (version !== generation.current) return;
      setContext(null);
      setError(null);
      await onSaved();
    } catch (cause) {
      if (version === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div>
      {!context ? (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading handoff…" : "Edit handoff"}
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p>
            Changes apply before successor admission. Saving requires the success criteria to be
            checked again.
          </p>
          <label>
            Successor
            <select
              value={targetId}
              disabled={busy}
              required
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Choose a successor</option>
              {context.targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.title} · {target.modelId ?? target.providerId} · {target.workspaceLabel}
                </option>
              ))}
            </select>
          </label>
          {context.successor.action === "create" && (
            <label>
              Task title
              <input
                value={title}
                disabled={busy}
                required
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          )}
          <label>
            Instruction
            <textarea
              value={prompt}
              disabled={busy}
              required
              maxLength={32_000}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label>
            Success criteria
            <textarea
              value={criteria}
              disabled={busy}
              required
              maxLength={4_000}
              onChange={(event) => setCriteria(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Saving handoff…" : "Save handoff"}
          </button>
          <button type="button" disabled={busy} onClick={() => setContext(null)}>
            Close editor
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
