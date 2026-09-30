import { useEffect } from "react";
import { useEvaluationSetup, type DatasetRelease } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import type { ModelsRoute } from "../models-route";
export function useDatasetTaskSelection(release: DatasetRelease | null) {
  const state = useEvaluationSetup();
  const identity = release ? JSON.stringify(release) : null;
  useEffect(() => { if (release) state.activate(release); }, [identity]);
  return state;
}
export function DatasetTaskSelection({ release, count, route }: { release: DatasetRelease; count: number; route: ModelsRoute }) {
  const state = useEvaluationSetup();
  const controls = useWorkspacePanelControls();
  return <div className="evaluation-workspace-scope" aria-label="Experiment task selection"><span>{state.count(release, count)} of {count} tasks selected{state.selection?.mode !== "subset" && !state.selection?.ids.length ? " · All tasks in this release" : ""}</span><button type="button" className="training-button secondary" onClick={() => state.selectAll(release, true)}>Select all {count} tasks</button><button type="button" className="training-button secondary" onClick={() => state.selectAll(release, false)}>Clear selection</button><button type="button" className="training-button" disabled={!state.count(release, count)} onClick={() => { state.open(null, release, route); controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} }); }}>Create Experiment</button></div>;
}
export function DatasetTaskCheckbox({ release, id }: { release: DatasetRelease; id: string }) {
  const selection = useEvaluationSetup();
  return <td onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><input type="checkbox" aria-label={`Select task ${id}`} checked={selection.selected(release, id)} onChange={event => selection.toggle(release, id, event.target.checked)} /></td>;
}
