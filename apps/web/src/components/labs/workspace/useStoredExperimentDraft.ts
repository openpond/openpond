import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalJson, type ExperimentDraft, type ExperimentDraftRecord, type ExperimentDraftSave } from "openpond-sdk/training";
import { useAppToast } from "../../../app/AppToastContext";
import { experimentDraftApi } from "./experiment-draft-api";
import { useEvaluationSetup } from "./EvaluationSetupState";
import type { WorkspaceApi } from "./workspace-api";

export function useStoredExperimentDraft(api: WorkspaceApi) {
  const setup = useEvaluationSetup(), queries = useQueryClient(), toast = useAppToast();
  const current = useRef<ExperimentDraftRecord | null>(setup.storedRecord);
  const pending = useRef<ExperimentDraftSave | null>(null);
  const writing = useRef(false);
  const scope = canonicalJson([api.connection.serverUrl, api.accountKey, api.actorId, api.teamId, api.projectId, setup.initialExperiment?.id]);
  const active = useRef(scope);
  useEffect(() => { active.current = scope; return () => { active.current = "unmounted"; }; }, [scope]);
  return async (draft: ExperimentDraft) => {
    if (setup.initialExperiment?.hostedEvaluationForm)
      throw new Error("Open this saved evaluation in its hosted editor to preserve its native settings.");
    if (writing.current) throw new Error("This experiment draft is already saving.");
    if (!api.actorId || draft.id !== setup.initialExperiment?.id)
      throw new Error("Reopen this experiment in the current account before saving.");
    writing.current = true;
    const fence = () => { if (active.current !== scope) throw new Error("The active experiment or account changed."); };
    const client = experimentDraftApi(api);
    try {
      fence();
      // A response may have been lost. Resolve its exact operation first,
      // including its old revision, before considering subsequently edited fields.
      if (pending.current) {
        const receipt = await client.save(pending.current);
        fence(); current.current = receipt.record; pending.current = null;
      }
      if (!current.current || canonicalJson(current.current.draft) !== canonicalJson(draft)) {
        pending.current = { schemaVersion: "openpond.experimentDraftSave.v1", teamId: api.teamId,
          operationId: crypto.randomUUID(), expectedRevision: current.current?.revision ?? 0,
          projectId: current.current?.projectId ?? api.projectId, draft };
        const receipt = await client.save(pending.current);
        fence(); current.current = receipt.record; pending.current = null;
      }
      // A retained receipt proves that write, not that it is still the current
      // document. Never silently overwrite a concurrent author's newer revision.
      const latest = await client.get(draft.id);
      fence();
      if (latest.contentHash !== current.current.contentHash)
        throw new Error("This draft changed elsewhere. Your edits are retained here. Reopen the saved draft to load its current revision.");
      setup.acceptSaved(latest);
      void queries.invalidateQueries({ queryKey: ["unified-experiments"] });
      toast?.("Experiment draft saved.", "success");
      return latest;
    } finally { writing.current = false; }
  };
}
