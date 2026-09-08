import { useRef, useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import { ModelTasksetDraftRequestSchema, type ModelTasksetDraftRequest } from "openpond-sdk/model-taskset-authoring";
import type { useTraining } from "../../hooks/useTraining";

export function ModelTasksetDraftAction({ model, training, onOpen }: {
  model: ModelProject; training: ReturnType<typeof useTraining>; onOpen: (draftId: string) => void;
}) {
  const storageKey = `openpond.taskset-draft-request:${JSON.stringify([training.connection?.serverUrl, model.profileId, model.id])}`;
  const [request, setRequest] = useState<ModelTasksetDraftRequest | null>(() => {
    try {
      const value = ModelTasksetDraftRequestSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
      return value.success && value.data.modelId === model.id ? value.data : null;
    } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  async function open() {
    if (active.current) return;
    active.current = true; setBusy(true); setError(null);
    try {
      let retained = request;
      if (!retained) {
        const source = await training.actions.inspectTasksetDraftSource(model.id, model.revision);
        if (!source) return;
        retained = ModelTasksetDraftRequestSchema.parse({ schemaVersion: "openpond.modelTasksetDraftRequest.v1", operationId: crypto.randomUUID(), ...source });
        localStorage.setItem(storageKey, JSON.stringify(retained));
        setRequest(retained);
      }
      const draft = await training.actions.createTasksetDraftFromSource(retained);
      if (!draft) return;
      localStorage.removeItem(storageKey); setRequest(null);
      onOpen(draft.id);
    } catch (error) { setError(error instanceof Error ? error.message : "The Taskset draft could not be opened."); }
    finally { active.current = false; setBusy(false); }
  }
  return <>
    <button className="training-button secondary" type="button" disabled={busy} onClick={() => void open()}>{busy ? "Opening draft…" : request ? "Resume draft creation" : "Revise Taskset"}</button>
    {request && !busy ? <button className="training-text-button" type="button" onClick={() => {
      try { localStorage.removeItem(storageKey); setRequest(null); setError(null); }
      catch (error) { setError(error instanceof Error ? error.message : "The pending request could not be cleared."); }
    }}>Use current selection for a new draft</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </>;
}
