import type { RunStageEvidence } from "@openpond/contracts";
import { modelsLocation, modelsPath, navigateModelsRoute } from "../labs/lab-primary-tab-state";
import "./training-recovery-lineage.css";

/** Display only server-verified checkpoint lineage, never inferred chart state. */
export function TrainingRecoveryLineage({ recovery }: { recovery: RunStageEvidence["recovery"] }) {
  if (!recovery) return null;
  const source = modelsLocation("runs", null, { area: "console", resourceId: `hosted-job:${recovery.sourceJobId}` });
  return <p className="training-recovery-lineage" title={`Checkpoint ${recovery.checkpointId}`}>
    Resumed from <a href={modelsPath(source)} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); void navigateModelsRoute(source);
    }}>run {recovery.sourceJobId.slice(-8)}</a>
    {` · policy v${recovery.policyVersion} · ${recovery.optimizerStateRestored ? "optimizer checkpoint restored" : "optimizer checkpoint not restored yet"}`}
    {` · ${recovery.completedGroups} ${recovery.completedGroups === 1 ? "group reused" : "groups reused"}`}
  </p>;
}
