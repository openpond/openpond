import { useManagedEngramExperiment } from "./useManagedEngramExperiment";
import { ManagedEngramExecution } from "./ManagedEngramExecution";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { useDraftNavigation } from "../useDraftNavigation";
import type { WorkspaceApi } from "./workspace-api";

/** Canonical history opens the execution itself; no mutable draft is required
 * to read a retained result or reconcile an original paid control. */
export function ManagedEngramDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const owner = useManagedEngramExperiment(api, {
    draftId: null,
    executionId: id,
    visible: true,
  });
  useWorkspaceResourceName(owner.execution?.name ?? "Engram experiment");
  const guard = useDraftNavigation({
    name: "Engram execution",
    busy: owner.busy,
    dirty: false,
  });
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1>{owner.execution?.name ?? "Engram experiment"}</h1>
      </header>
      <ManagedEngramExecution api={api} owner={owner} />
      {guard.dialog}
    </>
  );
}
