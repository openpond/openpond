import { useManagedActivationExperiment } from "./useManagedActivationExperiment";
import { ManagedActivationExecution } from "./ManagedActivationExecution";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { useDraftNavigation } from "../useDraftNavigation";
import { useEffect, useRef, useState } from "react";
import { ErrorToast } from "../../common/ErrorToast";
import { modelsLocation, type ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { activationExecutionDraft } from "./activation-execution-draft";
import type { WorkspaceApi } from "./workspace-api";

/** Canonical history opens the execution itself; no mutable draft is required
 * to read a retained result or reconcile an original paid control. */
export function ManagedModificationDetail({ api, id, route }: { api: WorkspaceApi; id: string; route: ModelsRoute }) {
  const setup = useEvaluationSetup();
  const [error, setError] = useState<unknown>(null), [opening, setOpening] = useState(false);
  const scope = JSON.stringify([api.key, api.connection.serverUrl, id]), live = useRef(scope), copying = useRef(false);
  live.current = scope;
  useEffect(() => {live.current = scope; return () => {live.current = "";};}, [scope]);
  const owner = useManagedActivationExperiment(api, {
    draftId: null,
    executionId: id,
    visible: true,
  });
  useWorkspaceResourceName(owner.execution?.name ?? "Activation experiment");
  const guard = useDraftNavigation({
    name: "Activation execution",
    busy: owner.busy || opening,
    dirty: false,
  });
  async function copySettings() {
    if (copying.current || !owner.execution || owner.busy || owner.loading || !owner.ready || !owner.canControl || owner.original) return;
    copying.current = true; setOpening(true); setError(null);
    try {
      const execution = owner.execution;
      const draft = activationExecutionDraft(execution, api);
      if (live.current !== scope) return;
      await setup.openDraft(draft, modelsLocation("experiments", null, {
        area: route.area, projectId: execution.projectId, executionLocation: "hosted",
      }));
    } catch (cause) {if (live.current === scope) setError(cause);}
    finally {copying.current = false; if (live.current === scope) setOpening(false);}
  }
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1>{owner.execution?.name ?? "Activation experiment"}</h1>
      </header>
      <ErrorToast error={error} />
      {owner.execution?.sourceForm ? <div className="model-build-actions">
        <button type="button" className="training-button secondary"
          disabled={opening || owner.busy || owner.loading || !owner.ready || !owner.canControl || Boolean(owner.original)}
          onClick={() => void copySettings()}>{opening ? "Opening settings…" : "Copy settings to new experiment"}</button>
      </div> : null}
      <ManagedActivationExecution api={api} owner={owner} />
      {guard.dialog}
    </>
  );
}
